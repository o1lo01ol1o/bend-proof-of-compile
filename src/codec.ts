import * as fs from "node:fs";
import * as path from "node:path";
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";

import type {
  AdtLike,
  BookRecord,
  BookStateLike,
  CompilerRuntime,
  ConstructorLike,
  DefinitionLike,
  HigherTerm,
  PlainTerm,
  SourceFileLike,
  SpanLike,
  TopLevelLike,
} from "./compiler.ts";
import { StoredTerms, TermTable } from "./term-table.ts";
import { PocError } from "./error.ts";

const PACK_SCHEMA = 9;

const MAX_COMPRESSED_BYTES = 1_000_000_000;
const MAX_UNCOMPRESSED_BYTES = 2_000_000_000;

type WireSpan = { readonly $span: readonly [number, number, number] };
type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue };

// A stored record: what a restore reads eagerly (names, counts, flags, the
// constructors' names, and `r`, the report's summary: the names the record's
// types and elaboration refer to), and `t`, the record's terms as one
// compressed blob (base64 of the raw-deflated JSON of `WireTerms`), inflated
// and raised on the record's first read. A restored chain thus holds its
// records' terms at their compressed size, not as parsed trees: one
// bend-categories module's chain of 55 packs is 260 MB of term JSON and 24 MB
// compressed. A definition with a value also has a checked body, stored in
// the pack's elaboration (below) and restored on first read.
interface WireAdt {
  readonly $: "ADT";
  readonly n: number;
  readonly g: number;
  readonly c: readonly WireConstructor[];
  readonly r: readonly string[];
  readonly t: string;
  readonly b?: boolean;
}

interface WireDefinition {
  readonly $: "Def";
  readonly n: number;
  readonly x: number;
  // Whether the definition has a value (and so a body in the elaboration).
  readonly v: boolean;
  readonly r: readonly string[];
  readonly t: string;
  readonly b?: boolean;
  readonly u?: boolean;
  readonly l?: boolean;
  readonly i?: readonly string[];
  // The declaring module's namespace (schema 9): a foreign def's C resolves
  // its CID(k) and FID(k) in it, so a restored one emits as a checked one.
  readonly m?: string;
}

interface WireConstructor {
  readonly k: string;
  readonly n: number;
  readonly f: string;
}

type WireTopLevel = WireAdt | WireDefinition;

// A record's terms: lowered terms whose spans are `WireSpan`s into the pack's
// source table. A datatype's `c` holds its constructors' types in order.
type WireTerms =
  | { readonly T: WireValue; readonly c: readonly WireValue[] }
  | { readonly T: WireValue; readonly v: WireValue | null };

function deflateTerms(text: string): string {
  return deflateRawSync(Buffer.from(text, "utf8"), { level: 6 }).toString("base64");
}

function inflateTerms(blob: string, location: string): string {
  try {
    return inflateRawSync(Buffer.from(blob, "base64")).toString("utf8");
  } catch (cause) {
    throw new PocError("CODEC", `the terms at ${location} are not valid deflate`, {}, { cause });
  }
}

// A pack is what one sealed boundary adds to the state it extends: the
// records a book_over child owns after book_valid (its events' names, a
// fill's copy of its law, and the instances minted while checking them),
// its slice of the event order, the instance-table entries its parent lacks,
// the files it loaded, the absolute counts of holes and open laws, and
// `last`, the order index where its last file's events begin (the loader's
// mark when that file is an entry). A state is its chain of packs, root
// first. The encoding is canonical: every table is sorted by name.
interface WirePack {
  readonly schema: number;
  readonly parent: string | null;
  readonly last: number;
  readonly sources: readonly SourceFileLike[];
  readonly tlds: readonly (readonly [string, WireTopLevel])[];
  readonly ctrs: readonly string[];
  readonly order: readonly string[];
  readonly hols: number;
  readonly tmps: readonly (readonly [string, readonly (readonly [string, string])[]])[];
  readonly seen: readonly (readonly [string, string | null])[];
}

// A pack's elaboration, stored beside its state under the same key: the term
// table (src/term-table.ts: every node of every checked body and of every
// cell value lowered at its depth, once per content) and each valued
// definition's body root. A check never reads it: restoring a chain of
// states parses states only. A build reads the elaborations of the packs
// whose definitions it compiles, one pack at a time, on the first read of a
// definition's body.
interface WireElaboration {
  readonly schema: number;
  readonly nodes: readonly WireValue[];
  readonly roots: readonly (readonly [string, number])[];
}

// The two texts of a pack.
export interface PackWire {
  readonly state: string;
  readonly elaboration: string;
}

export interface PackBytes {
  readonly state: Buffer;
  readonly elaboration: Buffer;
}

// The reference summaries of restored records, read without raising their
// terms. A record the checker creates (a fill's copy included) is a new
// object, so it is never found here and its summary is computed from its own
// terms.
const summaries = new WeakMap<TopLevelLike, readonly string[]>();

// The names a record's types and elaboration refer to, as the checker's
// report walks them (cli_report: constructor types for a datatype, the type
// and elaboration for a definition; spans skipped; shared nodes once).
export function referencesOf(runtime: CompilerRuntime, tld: TopLevelLike): readonly string[] {
  const stored = summaries.get(tld);
  if (stored !== undefined) {
    return stored;
  }
  const out = new Set<string>();
  const seen = new Set<object>();
  if (tld.$ === "ADT") {
    termRefs(runtime.Bend.term_lower(tld.T), out, seen);
    for (const constructor of tld.c) {
      termRefs(runtime.Bend.term_lower(constructor.T), out, seen);
    }
  } else {
    termRefs(runtime.Bend.term_lower(tld.T), out, seen);
    termRefs(tld.e, out, seen);
  }
  return [...out].sort();
}

// What the checker's report reads of a record: whether it is a promise
// (@unsafe, or foreign outside Base) and the names it refers to.
export type RecordSummary = BookRecord;

// Summaries of records not raised yet, per restored table, read from the
// wire, so a report never raises a restored record.
const pending = new WeakMap<object, Map<string, RecordSummary>>();

function promiseOf(tld: TopLevelLike): BookRecord["promise"] {
  return tld.$ === "Def" && tld.u === true ? "unsafe"
    : tld.$ === "Def" && tld.i !== undefined && tld.b !== true ? "foreign" : null;
}

// The summary of the record `name` resolves to through a chain of tables.
export function summaryOf(
  runtime: CompilerRuntime,
  table: Record<string, TopLevelLike>,
  name: string,
): RecordSummary | undefined {
  for (let level: object | null = table; level !== null; level = Object.getPrototypeOf(level) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(level, name);
    if (descriptor === undefined) {
      continue;
    }
    if ("value" in descriptor) {
      const tld = descriptor.value as TopLevelLike;
      return {
        base: tld.b === true,
        law: tld.$ === "Def" && tld.l === true,
        promise: promiseOf(tld),
        refs: referencesOf(runtime, tld),
      };
    }
    return pending.get(level)?.get(name);
  }
  return undefined;
}

// Every name a chain of tables resolves.
export function namesOf(table: object): string[] {
  const names = new Set<string>();
  for (let level: object | null = table; level !== null; level = Object.getPrototypeOf(level) as object | null) {
    for (const name of Object.keys(level)) {
      names.add(name);
    }
  }
  return [...names];
}

// An explicit stack and `for…in` (no per-node arrays): elaborations reach a
// few hundred thousand nodes, and a DAG's shared nodes are visited once.
function termRefs(term: unknown, out: Set<string>, seen: Set<object>): void {
  const stack: unknown[] = [term];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== "object" || node === null || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const fields = node as Record<string, unknown>;
    const tag = fields.$;
    if ((tag === "Ref" || tag === "ADT") && typeof fields.k === "string") {
      out.add(fields.k);
    }
    for (const field in fields) {
      if (field !== "s") {
        const value = fields[field];
        if (typeof value === "object" && value !== null) {
          stack.push(value);
        }
      }
    }
  }
}

const byName = <T>(left: readonly [string, T], right: readonly [string, T]): number =>
  left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;

// The canonical wire texts of the records `child` adds over `parent`, where
// child = book_over(parent) after book_valid (or any book whose own table keys
// are its additions): the state, and the elaboration of its valued
// definitions. `last` is the order index where its last file begins.
export function encodePackWire(
  runtime: CompilerRuntime,
  parentKey: string | null,
  parent: BookStateLike,
  child: BookStateLike,
  last: number,
): PackWire {
  try {
    const book = child.book;
    const names = Object.keys(book.tlds).sort();
    const table = new TermTable(runtime.Bend);
    const roots: Array<readonly [string, number]> = [];
    const sources: SourceFileLike[] = [];
    const sourceIds = new Map<string, number>();
    // Source files are stable during this encoding. Reuse their content ID
    // without repeatedly serializing the full file for every span; equal but
    // distinct files still share the canonical content-based source table.
    const sourceObjects = new WeakMap<SourceFileLike, number>();
    const replacer = function (this: unknown, _key: string, value: unknown): unknown {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new PocError("CODEC", "term contains a non-finite number", { value });
      }
      if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
        throw new PocError("CODEC", "lowered term contains a non-data value", { type: typeof value });
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value) && isSpan(value)) {
        // A parser is also a File, but its extra fields include a cyclic book.
        // Persist only the File interface needed for diagnostics and name display.
        const file = value.file;
        let sourceId = sourceObjects.get(file);
        if (sourceId === undefined) {
          const source: SourceFileLike = {
            str: file.str,
            ns: file.ns,
            al: Object.fromEntries(Object.entries(file.al).sort(byName)),
          };
          const key = JSON.stringify(source);
          sourceId = sourceIds.get(key);
          if (sourceId === undefined) {
            sourceId = sources.length;
            sources.push(source);
            sourceIds.set(key, sourceId);
          }
          sourceObjects.set(file, sourceId);
        }
        return { $span: [sourceId, value.beg, value.end] } satisfies WireSpan;
      }
      return value;
    };
    // Each record's lowered terms are written by one stringify pass with the
    // replacer, which turns each span into a reference to its interned source
    // text, and stored as one compressed blob.
    const tlds = names.map((name) => {
      const tld = book.tlds[name];
      if (tld === undefined) {
        throw new PocError("CODEC", `book.tlds.${name} is missing`);
      }
      return [name, encodeTopLevel(runtime, name, tld, (terms) => deflateTerms(JSON.stringify(terms, replacer)), table, roots)] as const;
    });
    const records = JSON.stringify(tlds, replacer);
    const elaboration = JSON.stringify({ schema: PACK_SCHEMA, nodes: table.nodes as readonly WireValue[], roots } satisfies WireElaboration, replacer);
    const done = parent.book.order.length;
    if (
      book.order.length < done ||
      book.order.slice(0, done).some((name, index) => name !== parent.book.order[index]) ||
      !Number.isSafeInteger(last) ||
      last < done ||
      last > book.order.length
    ) {
      throw new PocError("CODEC", "a pack's order does not extend its parent's");
    }
    const tmps: Array<readonly [string, Array<readonly [string, string]>]> = [];
    for (const name of Object.keys(book.tmps).sort()) {
      const inherited = parent.book.tmps[name];
      const added = [...(book.tmps[name] ?? new Map<string, string>())]
        .filter(([key]) => inherited === undefined || !inherited.has(key))
        .sort(byName);
      if (added.length > 0) {
        tmps.push([name, added]);
      }
    }
    // The fields of WirePack, in its order; `records` is the `tlds` text.
    const head = JSON.stringify({ schema: PACK_SCHEMA, parent: parentKey, last } satisfies Pick<WirePack, "schema" | "parent" | "last">);
    const tail = JSON.stringify({
      ctrs: Object.keys(book.ctrs).sort(),
      order: book.order.slice(done),
      hols: book.hols,
      tmps,
      seen: [...child.seen.entries()].filter(([file]) => !parent.seen.has(file)).sort(byName),
    } satisfies Omit<WirePack, "schema" | "parent" | "last" | "sources" | "tlds">);
    return {
      state: `${head.slice(0, -1)},"sources":${JSON.stringify(sources)},"tlds":${records},${tail.slice(1)}`,
      elaboration,
    };
  } catch (cause) {
    if (cause instanceof PocError) {
      throw cause;
    }
    throw new PocError("CODEC", `could not encode a checked Bend pack: ${cause instanceof Error ? cause.message : String(cause)}`, {}, { cause });
  }
}

export function encodePack(
  runtime: CompilerRuntime,
  parentKey: string | null,
  parent: BookStateLike,
  child: BookStateLike,
  last: number,
): PackBytes {
  const wire = encodePackWire(runtime, parentKey, parent, child, last);
  return {
    state: gzipSync(Buffer.from(wire.state, "utf8"), { level: 6 }),
    elaboration: gzipSync(Buffer.from(wire.elaboration, "utf8"), { level: 6 }),
  };
}

export interface DecodedPack {
  readonly parent: string | null;
  readonly last: number;
  // Adds the pack to the flat state it extends. Records are raised lazily:
  // each table entry is an accessor that raises its record on first read and
  // then becomes a plain data property; its setter makes an assignment through
  // a child table (a fill of a restored law) an own property of that child.
  readonly apply: (state: BookStateLike) => void;
  // Raises every record and every body now (verification).
  readonly force: () => void;
}

function inflate(compressed: Uint8Array, what: string): string {
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
    throw new PocError("CODEC", `compressed ${what} exceeds the size limit`, {
      bytes: compressed.byteLength,
      limit: MAX_COMPRESSED_BYTES,
    });
  }
  try {
    return gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES }).toString("utf8");
  } catch (cause) {
    throw new PocError("CODEC", `${what} is not valid gzip`, {}, { cause });
  }
}

// `elaboration` is read when a body is first needed, never for a check.
export function decodePack(runtime: CompilerRuntime, state: Uint8Array, elaboration: () => Uint8Array): DecodedPack {
  return decodePackWire(runtime, inflate(state, "pack"), () => inflate(elaboration(), "elaboration"));
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new PocError("CODEC", `${what} is not valid JSON`, {}, { cause });
  }
}

export function decodePackWire(runtime: CompilerRuntime, text: string, elaboration: () => string): DecodedPack {
  const parsed = parseJson(text, "pack");

  try {
    const root = record(parsed, "pack");
    integer(root.schema, "pack.schema");
    if (root.schema !== PACK_SCHEMA) {
      throw new PocError("CODEC", "unsupported pack schema", {
        expected: PACK_SCHEMA,
        found: root.schema,
      });
    }
    const parent = root.parent === null ? null : string(root.parent, "pack.parent");
    const last = nonNegativeInteger(root.last, "pack.last");
    const sources = array(root.sources, "pack.sources").map((value, index): SourceFileLike => {
      const location = `pack.sources[${index}]`;
      const raw = record(value, location);
      const aliases = record(raw.al, `${location}.al`);
      return {
        str: string(raw.str, `${location}.str`),
        ns: string(raw.ns, `${location}.ns`),
        al: Object.fromEntries(Object.entries(aliases).map(([key, item]) =>
          [key, string(item, `${location}.al.${key}`)])),
      };
    });
    // The elaboration is read, parsed and restored (interned names) when a
    // body is first needed, once per pack, and shared by every body of the
    // pack. Its roots must name this pack's valued definitions, exactly.
    let loaded: Elaboration | undefined;
    const stored = (): Elaboration => {
      if (loaded === undefined) {
        const raw = record(parseJson(elaboration(), "elaboration"), "elaboration");
        if (raw.schema !== PACK_SCHEMA) {
          throw new PocError("CODEC", "unsupported elaboration schema", { expected: PACK_SCHEMA, found: raw.schema });
        }
        const roots = new Map<string, number>();
        for (const [index, item] of array(raw.roots, "elaboration.roots").entries()) {
          const pair = tuple(item, 2, `elaboration.roots[${index}]`);
          const name = string(pair[0], `elaboration.roots[${index}][0]`);
          const entry = tlds.get(name);
          if (entry === undefined || !entry.valued) {
            throw new PocError("CODEC", `the elaboration names ${name}, which is not a valued definition of its pack`);
          }
          if (roots.has(name)) {
            throw new PocError("CODEC", `the elaboration names ${name} twice`);
          }
          roots.set(name, nonNegativeInteger(pair[1], `elaboration.roots[${index}][1]`));
        }
        const nodes = array(raw.nodes, "elaboration.nodes").map((value, index) => restoreValue(value, sources, `elaboration.nodes[${index}]`));
        loaded = { terms: new StoredTerms(runtime.Bend, nodes), roots };
      }
      return loaded;
    };

    // Names and constructor ownership are parsed now; terms when first read.
    const tlds = new Map<
      string,
      { readonly raise: () => TopLevelLike; readonly adt: boolean; readonly valued: boolean; readonly summary: RecordSummary }
    >();
    const ctrOwners = new Map<string, string>();
    for (const [index, rawEntry] of array(root.tlds, "pack.tlds").entries()) {
      const pair = tuple(rawEntry, 2, `pack.tlds[${index}]`);
      const name = string(pair[0], `pack.tlds[${index}][0]`);
      if (tlds.has(name)) {
        throw new PocError("CODEC", `duplicate top-level name ${name}`);
      }
      const location = `pack.tlds[${index}][1]`;
      const raw = record(pair[1], location);
      const tag = string(raw.$, `${location}.$`);
      if (tag !== "ADT" && tag !== "Def") {
        throw new PocError("CODEC", `unknown top-level tag ${tag}`, { location, tag });
      }
      if (tag === "ADT") {
        for (const [ctrIndex, item] of array(raw.c, `${location}.c`).entries()) {
          const ctr = string(record(item, `${location}.c[${ctrIndex}]`).k, `${location}.c[${ctrIndex}].k`);
          if (ctrOwners.has(ctr)) {
            throw new PocError("CODEC", `duplicate constructor ${ctr}`);
          }
          ctrOwners.set(ctr, name);
        }
      }
      let raised: TopLevelLike | undefined;
      const foreign = raw.i !== undefined;
      tlds.set(name, {
        adt: tag === "ADT",
        valued: tag === "Def" && raw.v === true,
        summary: {
          base: raw.b === true,
          law: tag === "Def" && raw.l === true,
          promise: tag === "Def" && raw.u === true ? "unsafe"
            : tag === "Def" && foreign && raw.b !== true ? "foreign" : null,
          refs: stringArray(raw.r, `${location}.r`),
        },
        raise: () => {
          if (raised === undefined) {
            raised = decodeTopLevel(runtime, name, raw, sources, location, stored);
          }
          return raised;
        },
      });
    }
    const expectedCtrs = stringArray(root.ctrs, "pack.ctrs");
    if (
      expectedCtrs.length !== ctrOwners.size ||
      expectedCtrs.some((name) => !ctrOwners.has(name))
    ) {
      throw new PocError("CODEC", "pack constructor index disagrees with its ADTs");
    }
    const order = stringArray(root.order, "pack.order").map(intern);
    const hols = nonNegativeInteger(root.hols, "pack.hols");
    const tmps: Array<readonly [string, Array<readonly [string, string]>]> = [];
    for (const [index, rawEntry] of array(root.tmps, "pack.tmps").entries()) {
      const pair = tuple(rawEntry, 2, `pack.tmps[${index}]`);
      const name = string(pair[0], `pack.tmps[${index}][0]`);
      const entries = array(pair[1], `pack.tmps[${index}][1]`).map((rawItem, itemIndex) => {
        const item = tuple(rawItem, 2, `pack.tmps[${index}][1][${itemIndex}]`);
        return [string(item[0], "template key"), intern(string(item[1], "template value"))] as const;
      });
      tmps.push([name, entries]);
    }
    const seen = array(root.seen, "pack.seen").map((rawEntry, index) => {
      const pair = tuple(rawEntry, 2, `pack.seen[${index}]`);
      const file = string(pair[0], `pack.seen[${index}][0]`);
      const namespace = pair[1] === null ? null : string(pair[1], `pack.seen[${index}][1]`);
      return [file, namespace] as const;
    });

    return {
      parent,
      last,
      force() {
        for (const entry of tlds.values()) {
          const tld = entry.raise();
          if (tld.$ === "Def" && tld.v !== null) {
            void tld.e;
          }
        }
      },
      apply(state) {
        const book = state.book;
        if (last < book.order.length || last > book.order.length + order.length) {
          throw new PocError("CODEC", "pack.last is outside its order slice");
        }
        let summaries = pending.get(book.tlds);
        if (summaries === undefined) {
          summaries = new Map();
          pending.set(book.tlds, summaries);
        }
        for (const [name, entry] of tlds) {
          lazyProperty(book.tlds, name, entry.raise);
          summaries.set(name, entry.summary);
        }
        for (const [ctr, owner] of ctrOwners) {
          const entry = tlds.get(owner);
          lazyProperty(book.ctrs, ctr, () => {
            const adt = entry?.raise();
            const found = adt?.$ === "ADT" ? adt.c.find((item) => item.k === ctr) : undefined;
            if (found === undefined) {
              throw new PocError("CODEC", `constructor ${ctr} is missing from ${owner}`);
            }
            return found;
          });
        }
        book.order.push(...order);
        book.hols = hols;
        for (const [name, entries] of tmps) {
          const table = book.tmps[name] ?? new Map<string, string>();
          for (const [key, value] of entries) {
            if (table.has(key)) {
              throw new PocError("CODEC", `pack redefines template key ${name} ${key}`);
            }
            table.set(key, value);
          }
          book.tmps[name] = table;
        }
        for (const [file, namespace] of seen) {
          if (state.seen.has(file)) {
            throw new PocError("CODEC", `pack reloads ${file}`);
          }
          state.seen.set(file, namespace);
        }
      },
    };
  } catch (cause) {
    if (cause instanceof PocError) {
      throw cause;
    }
    throw new PocError("CODEC", "pack has an invalid shape", {}, { cause });
  }
}

function lazyProperty<T>(table: Record<string, T>, name: string, raise: () => T): void {
  const own = (target: object, value: T): void => {
    Object.defineProperty(target, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  };
  Object.defineProperty(table, name, {
    enumerable: true,
    configurable: true,
    get() {
      const value = raise();
      own(table, value);
      return value;
    },
    set(this: object, value: T) {
      own(this, value);
    },
  });
}

function encodeTopLevel(
  runtime: CompilerRuntime,
  name: string,
  tld: TopLevelLike,
  blob: (terms: { readonly T: PlainTerm; readonly c: readonly PlainTerm[] } | { readonly T: PlainTerm; readonly v: PlainTerm | null }) => string,
  table: TermTable,
  roots: Array<readonly [string, number]>,
): WireTopLevel {
  const r = referencesOf(runtime, tld);
  const lower = (term: HigherTerm): PlainTerm => runtime.Bend.term_lower(term);
  if (tld.$ === "ADT") {
    return {
      $: "ADT",
      n: tld.n,
      g: tld.g,
      c: tld.c.map((constructor) => ({
        k: constructor.k,
        n: constructor.n,
        f: constructor.f,
      })),
      r,
      t: blob({ T: lower(tld.T), c: tld.c.map((constructor) => lower(constructor.T)) }),
      ...(tld.b === undefined ? {} : { b: tld.b }),
    };
  }
  storeBody(name, tld, table, roots);
  return {
    $: "Def",
    n: tld.n,
    x: tld.x,
    v: tld.v !== null,
    r,
    t: blob({ T: lower(tld.T), v: tld.v === null ? null : lower(tld.v) }),
    ...(tld.b === undefined ? {} : { b: tld.b }),
    ...(tld.u === undefined ? {} : { u: tld.u }),
    ...(tld.l === undefined ? {} : { l: tld.l }),
    ...(tld.i === undefined ? {} : { i: tld.i.map(pathReal) }),
    ...(tld.m === undefined ? {} : { m: tld.m }),
  };
}

// A definition with a value is checked, so it has a body, stored in the
// elaboration; a declaration (a law not yet filled, a foreign def) has none.
function storeBody(name: string, tld: DefinitionLike, table: TermTable, roots: Array<readonly [string, number]>): void {
  if (tld.v === null) {
    if (tld.e !== undefined) {
      throw new PocError("CODEC", `the declaration ${name} has a checked body`);
    }
    return;
  }
  if (tld.e === undefined) {
    throw new PocError("CODEC", `the definition ${name} has a value but no checked body`);
  }
  roots.push([name, table.body(tld.e)]);
}

interface Elaboration {
  readonly terms: StoredTerms;
  readonly roots: Map<string, number>;
}

// A field computed on first read, then a plain data property.
function lazyField<T extends object>(target: T, name: string, make: () => unknown): void {
  Object.defineProperty(target, name, {
    enumerable: true,
    configurable: true,
    get() {
      const value = make();
      Object.defineProperty(target, name, { value, writable: true, enumerable: true, configurable: true });
      return value;
    },
    set(value: unknown) {
      Object.defineProperty(target, name, { value, writable: true, enumerable: true, configurable: true });
    },
  });
}

// A path as the checker's CLI resolves it (main.ts path_real): its realpath
// when it exists. Foreign paths are stored this way, so a state does not
// depend on the spelling of the path its file was loaded through.
export function pathReal(file: string): string {
  return fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
}

function decodeTopLevel(
  runtime: CompilerRuntime,
  name: string,
  raw: Record<string, unknown>,
  sources: readonly SourceFileLike[],
  location: string,
  stored: () => Elaboration,
): TopLevelLike {
  const references = stringArray(raw.r, `${location}.r`);
  // The record's terms, inflated and parsed now that the record is read.
  const terms = record(parseJson(inflateTerms(string(raw.t, `${location}.t`), `${location}.t`), `${location}.t`), `${location}.t`);
  let result: TopLevelLike;
  if (raw.$ === "ADT") {
    const types = array(terms.c, `${location}.t.c`);
    const constructors = array(raw.c, `${location}.c`).map((item, index) => {
      const source = record(item, `${location}.c[${index}]`);
      if (types[index] === undefined) {
        throw new PocError("CODEC", `the terms of ${name} lack constructor ${index}'s type`);
      }
      return {
        k: intern(string(source.k, `${location}.c[${index}].k`)),
        n: nonNegativeInteger(source.n, `${location}.c[${index}].n`),
        T: higher(runtime, types[index], sources, `${location}.t.c[${index}]`),
        f: intern(string(source.f, `${location}.c[${index}].f`)),
      } satisfies ConstructorLike;
    });
    if (types.length !== constructors.length) {
      throw new PocError("CODEC", `the terms of ${name} hold ${types.length} constructor types for ${constructors.length} constructors`);
    }
    const adt: AdtLike = {
      $: "ADT",
      n: nonNegativeInteger(raw.n, `${location}.n`),
      g: nonNegativeInteger(raw.g, `${location}.g`),
      T: higher(runtime, terms.T, sources, `${location}.t.T`),
      c: constructors,
    };
    assignOptionalBoolean(adt, "b", raw.b, `${location}.b`);
    result = adt;
  } else {
    const valued = boolean(raw.v, `${location}.v`);
    if (valued === (terms.v === null)) {
      throw new PocError("CODEC", `the terms of ${name} disagree with its record about having a value`);
    }
    const definition: DefinitionLike = {
      $: "Def",
      n: nonNegativeInteger(raw.n, `${location}.n`),
      x: nonNegativeInteger(raw.x, `${location}.x`),
      T: higher(runtime, terms.T, sources, `${location}.t.T`),
      v: terms.v === null ? null : higher(runtime, terms.v, sources, `${location}.t.v`),
    };
    assignOptionalBoolean(definition, "b", raw.b, `${location}.b`);
    assignOptionalBoolean(definition, "u", raw.u, `${location}.u`);
    assignOptionalBoolean(definition, "l", raw.l, `${location}.l`);
    if (raw.i !== undefined) {
      definition.i = stringArray(raw.i, `${location}.i`);
    }
    if (raw.m !== undefined) {
      definition.m = string(raw.m, `${location}.m`);
    }
    if (definition.v !== null) {
      // The body is restored from the pack's elaboration on first read.
      lazyField(definition, "e", () => {
        const { terms, roots } = stored();
        const root = roots.get(name);
        if (root === undefined) {
          throw new PocError("CODEC", `the elaboration of ${name} is missing from its pack`);
        }
        return terms.body(root);
      });
    }
    result = definition;
  }
  summaries.set(result, references);
  return result;
}

function higher(
  runtime: CompilerRuntime,
  value: unknown,
  sources: readonly SourceFileLike[],
  location: string,
): ReturnType<CompilerRuntime["Bend"]["term_higher"]> {
  return runtime.Bend.term_higher(restoreValue(value, sources, location) as PlainTerm);
}

// Names come back from JSON as fresh strings. The checker looks names up in
// its tables (`book.tlds[k]`) on its hottest path, and JavaScriptCore turns a
// key string into an atom on every such lookup unless it already is one: a
// check over a restored state ran ~60% slower than cold until restored names
// were atoms. An object's own key is an atom, so a name is interned by taking
// it back out of one; each distinct name is atomized once per process.
const interned = new Map<string, string>();

function intern(text: string): string {
  const known = interned.get(text);
  if (known !== undefined) {
    return known;
  }
  const atom = Object.keys({ [text]: 0 })[0] as string;
  interned.set(atom, atom);
  return atom;
}

function restoreValue(value: unknown, sources: readonly SourceFileLike[], location: string): unknown {
  if (typeof value === "string") {
    return intern(value);
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PocError("CODEC", `non-finite number at ${location}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => restoreValue(item, sources, `${location}[${index}]`));
  }
  const raw = record(value, location);
  if (Object.hasOwn(raw, "$span")) {
    if (Object.keys(raw).length !== 1) {
      throw new PocError("CODEC", `span has extra fields at ${location}`);
    }
    const encoded = tuple(raw.$span, 3, `${location}.$span`);
    const sourceId = nonNegativeInteger(encoded[0], `${location}.$span[0]`);
    const file = sources[sourceId];
    if (file === undefined) {
      throw new PocError("CODEC", `span source is out of range at ${location}`, {
        sourceId,
      });
    }
    return {
      file,
      beg: nonNegativeInteger(encoded[1], `${location}.$span[1]`),
      end: nonNegativeInteger(encoded[2], `${location}.$span[2]`),
    };
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(raw)) {
    output[key] = restoreValue(item, sources, `${location}.${key}`);
  }
  return output;
}

function isSpan(value: object): value is SpanLike {
  const raw = value as Partial<SpanLike>;
  return (
    typeof raw.file === "object" && raw.file !== null &&
    typeof raw.file.str === "string" && typeof raw.file.ns === "string" &&
    typeof raw.file.al === "object" && raw.file.al !== null &&
    Number.isInteger(raw.beg) &&
    Number.isInteger(raw.end) &&
    Object.keys(value).length === 3
  );
}

function assignOptionalBoolean<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
  location: string,
): void {
  if (value !== undefined) {
    target[key] = boolean(value, location) as T[K];
  }
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PocError("CODEC", `expected object at ${location}`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new PocError("CODEC", `expected array at ${location}`);
  }
  return value;
}

function tuple(value: unknown, length: number, location: string): unknown[] {
  const result = array(value, location);
  if (result.length !== length) {
    throw new PocError("CODEC", `expected ${length}-tuple at ${location}`);
  }
  return result;
}

function string(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new PocError("CODEC", `expected string at ${location}`);
  }
  return value;
}

function boolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") {
    throw new PocError("CODEC", `expected boolean at ${location}`);
  }
  return value;
}

function integer(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PocError("CODEC", `expected safe integer at ${location}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, location: string): number {
  const result = integer(value, location);
  if (result < 0) {
    throw new PocError("CODEC", `expected non-negative integer at ${location}`);
  }
  return result;
}

function stringArray(value: unknown, location: string): string[] {
  return array(value, location).map((item, index) => string(item, `${location}[${index}]`));
}
