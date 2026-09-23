import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import type {
  AdtLike,
  BookStateLike,
  CompilerRuntime,
  ConstructorLike,
  DefinitionLike,
  PlainTerm,
  TopLevelLike,
} from "./compiler.ts";
import { PocError } from "./error.ts";

const PACK_SCHEMA = 3;
const MAX_COMPRESSED_BYTES = 1_000_000_000;
const MAX_UNCOMPRESSED_BYTES = 2_000_000_000;

type WireSpan = { readonly $span: readonly [number, number, number] };
type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue };

// A stored record. Elaborations (`e`) are not stored: they hold checker
// levels that a raise without an environment misreads (F1), and only the
// compiler and the report read them. `r` is the report's summary instead: the
// names the record's types and elaboration refer to. `Term` is a lowered
// term: the encoder builds records of the checker's lowered terms, whose spans
// the one stringify pass writes as `WireSpan`s.
interface WireAdt<Term> {
  readonly $: "ADT";
  readonly n: number;
  readonly g: number;
  readonly T: Term;
  readonly c: readonly WireConstructor<Term>[];
  readonly r: readonly string[];
  readonly b?: boolean;
}

interface WireDefinition<Term> {
  readonly $: "Def";
  readonly n: number;
  readonly x: number;
  readonly T: Term;
  readonly v: Term | null;
  readonly r: readonly string[];
  readonly b?: boolean;
  readonly u?: boolean;
  readonly i?: readonly string[];
}

interface WireConstructor<Term> {
  readonly k: string;
  readonly n: number;
  readonly T: Term;
}

type WireTopLevel<Term> = WireAdt<Term> | WireDefinition<Term>;

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
  readonly sources: readonly string[];
  readonly tlds: readonly (readonly [string, WireTopLevel<WireValue>])[];
  readonly ctrs: readonly string[];
  readonly order: readonly string[];
  readonly hols: number;
  readonly open: number;
  readonly tmps: readonly (readonly [string, readonly (readonly [string, string])[]])[];
  readonly seen: readonly (readonly [string, string | null])[];
}

// The reference summaries of restored records, whose elaborations are gone.
// A record the checker creates (a fill's copy included) is a new object, so
// it is never found here and its summary is computed from its own terms.
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
export interface RecordSummary {
  readonly promise: boolean;
  readonly refs: readonly string[];
}

// Summaries of records not raised yet, per restored table, read from the
// wire, so a report never raises a restored record.
const pending = new WeakMap<object, Map<string, RecordSummary>>();

function promiseOf(tld: TopLevelLike): boolean {
  return tld.$ === "Def" && (tld.u === true || (tld.i !== undefined && tld.b !== true));
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
      return { promise: promiseOf(tld), refs: referencesOf(runtime, tld) };
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

// The canonical wire text of the records `child` adds over `parent`, where
// child = book_over(parent) after book_valid (or any book whose own table keys
// are its additions). `last` is the order index where its last file begins.
export function encodePackWire(
  runtime: CompilerRuntime,
  parentKey: string | null,
  parent: BookStateLike,
  child: BookStateLike,
  last: number,
): string {
  try {
    const book = child.book;
    const names = Object.keys(book.tlds).sort();
    // Records hold lowered terms; one stringify pass writes them, turning each
    // span into a reference to its interned source text.
    const tlds = names.map((name) => {
      const tld = book.tlds[name];
      if (tld === undefined) {
        throw new PocError("CODEC", `book.tlds.${name} is missing`);
      }
      return [name, encodeTopLevel(runtime, tld, (term) => runtime.Bend.term_lower(term))] as const;
    });
    const sources: string[] = [];
    const sourceIds = new Map<string, number>();
    const records = JSON.stringify(tlds, function (this: unknown, _key: string, value: unknown): unknown {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new PocError("CODEC", "term contains a non-finite number", { value });
      }
      if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
        throw new PocError("CODEC", "lowered term contains a non-data value", { type: typeof value });
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value) && isSpan(value)) {
        let sourceId = sourceIds.get(value.src);
        if (sourceId === undefined) {
          sourceId = sources.length;
          sources.push(value.src);
          sourceIds.set(value.src, sourceId);
        }
        return { $span: [sourceId, value.beg, value.end] } satisfies WireSpan;
      }
      return value;
    });
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
      const added = Object.entries(book.tmps[name] ?? {})
        .filter(([key]) => inherited === undefined || !Object.hasOwn(inherited, key))
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
      open: book.open,
      tmps,
      seen: [...child.seen.entries()].filter(([file]) => !parent.seen.has(file)).sort(byName),
    } satisfies Omit<WirePack, "schema" | "parent" | "last" | "sources" | "tlds">);
    return `${head.slice(0, -1)},"sources":${JSON.stringify(sources)},"tlds":${records},${tail.slice(1)}`;
  } catch (cause) {
    if (cause instanceof PocError) {
      throw cause;
    }
    throw new PocError("CODEC", "could not encode a checked Bend pack", {}, { cause });
  }
}

export function encodePack(
  runtime: CompilerRuntime,
  parentKey: string | null,
  parent: BookStateLike,
  child: BookStateLike,
  last: number,
): Buffer {
  return gzipSync(
    Buffer.from(encodePackWire(runtime, parentKey, parent, child, last), "utf8"),
    { level: 6 },
  );
}

export interface DecodedPack {
  readonly parent: string | null;
  readonly last: number;
  // Adds the pack to the flat state it extends. Records are raised lazily:
  // each table entry is an accessor that raises its record on first read and
  // then becomes a plain data property; its setter makes an assignment through
  // a child table (a fill of a restored law) an own property of that child.
  readonly apply: (state: BookStateLike) => void;
  // Raises every record now (verification).
  readonly force: () => void;
}

export function decodePack(runtime: CompilerRuntime, compressed: Uint8Array): DecodedPack {
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
    throw new PocError("CODEC", "compressed pack exceeds the size limit", {
      bytes: compressed.byteLength,
      limit: MAX_COMPRESSED_BYTES,
    });
  }
  let plain: string;
  try {
    plain = gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES }).toString("utf8");
  } catch (cause) {
    throw new PocError("CODEC", "pack is not valid gzip", {}, { cause });
  }
  return decodePackWire(runtime, plain);
}

export function decodePackWire(runtime: CompilerRuntime, text: string): DecodedPack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new PocError("CODEC", "pack is not valid JSON", {}, { cause });
  }

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
    const sources = stringArray(root.sources, "pack.sources");

    // Names and constructor ownership are parsed now; terms when first read.
    const tlds = new Map<
      string,
      { readonly raise: () => TopLevelLike; readonly adt: boolean; readonly summary: RecordSummary }
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
        summary: {
          promise: tag === "Def" && (raw.u === true || (foreign && raw.b !== true)),
          refs: stringArray(raw.r, `${location}.r`),
        },
        raise: () => {
          if (raised === undefined) {
            raised = decodeTopLevel(runtime, raw, sources, location);
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
    const open = nonNegativeInteger(root.open, "pack.open");
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
          entry.raise();
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
        book.open = open;
        for (const [name, entries] of tmps) {
          const table = book.tmps[name] ?? (Object.create(null) as Record<string, string>);
          for (const [key, value] of entries) {
            if (Object.hasOwn(table, key)) {
              throw new PocError("CODEC", `pack redefines template key ${name} ${key}`);
            }
            table[key] = value;
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
  tld: TopLevelLike,
  lower: (term: Parameters<CompilerRuntime["Bend"]["term_lower"]>[0]) => PlainTerm,
): WireTopLevel<PlainTerm> {
  const r = referencesOf(runtime, tld);
  if (tld.$ === "ADT") {
    return {
      $: "ADT",
      n: tld.n,
      g: tld.g,
      T: lower(tld.T),
      c: tld.c.map((constructor) => ({
        k: constructor.k,
        n: constructor.n,
        T: lower(constructor.T),
      })),
      r,
      ...(tld.b === undefined ? {} : { b: tld.b }),
    };
  }
  return {
    $: "Def",
    n: tld.n,
    x: tld.x,
    T: lower(tld.T),
    v: tld.v === null ? null : lower(tld.v),
    r,
    ...(tld.b === undefined ? {} : { b: tld.b }),
    ...(tld.u === undefined ? {} : { u: tld.u }),
    ...(tld.i === undefined ? {} : { i: tld.i.map(pathReal) }),
  };
}

// A path as the checker's CLI resolves it (main.ts path_real): its realpath
// when it exists. Foreign paths are stored this way, so a state does not
// depend on the spelling of the path its file was loaded through.
export function pathReal(file: string): string {
  return fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
}

function decodeTopLevel(
  runtime: CompilerRuntime,
  raw: Record<string, unknown>,
  sources: readonly string[],
  location: string,
): TopLevelLike {
  const references = stringArray(raw.r, `${location}.r`);
  let result: TopLevelLike;
  if (raw.$ === "ADT") {
    const constructors = array(raw.c, `${location}.c`).map((item, index) => {
      const source = record(item, `${location}.c[${index}]`);
      return {
        k: intern(string(source.k, `${location}.c[${index}].k`)),
        n: nonNegativeInteger(source.n, `${location}.c[${index}].n`),
        T: higher(runtime, source.T, sources, `${location}.c[${index}].T`),
      } satisfies ConstructorLike;
    });
    const adt: AdtLike = {
      $: "ADT",
      n: nonNegativeInteger(raw.n, `${location}.n`),
      g: nonNegativeInteger(raw.g, `${location}.g`),
      T: higher(runtime, raw.T, sources, `${location}.T`),
      c: constructors,
    };
    assignOptionalBoolean(adt, "b", raw.b, `${location}.b`);
    result = adt;
  } else {
    const definition: DefinitionLike = {
      $: "Def",
      n: nonNegativeInteger(raw.n, `${location}.n`),
      x: nonNegativeInteger(raw.x, `${location}.x`),
      T: higher(runtime, raw.T, sources, `${location}.T`),
      v: raw.v === null ? null : higher(runtime, raw.v, sources, `${location}.v`),
    };
    assignOptionalBoolean(definition, "b", raw.b, `${location}.b`);
    assignOptionalBoolean(definition, "u", raw.u, `${location}.u`);
    if (raw.i !== undefined) {
      definition.i = stringArray(raw.i, `${location}.i`);
    }
    result = definition;
  }
  summaries.set(result, references);
  return result;
}

function higher(
  runtime: CompilerRuntime,
  value: unknown,
  sources: readonly string[],
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

function restoreValue(value: unknown, sources: readonly string[], location: string): unknown {
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
    const src = sources[sourceId];
    if (src === undefined) {
      throw new PocError("CODEC", `span source is out of range at ${location}`, {
        sourceId,
      });
    }
    return {
      src,
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

function isSpan(value: object): value is { src: string; beg: number; end: number } {
  const raw = value as { src?: unknown; beg?: unknown; end?: unknown };
  return (
    typeof raw.src === "string" &&
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
