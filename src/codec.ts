import { gunzipSync, gzipSync } from "node:zlib";

import type {
  AdtLike,
  BookLike,
  BookStateLike,
  CompilerRuntime,
  ConstructorLike,
  DefinitionLike,
  PlainTerm,
  TopLevelLike,
} from "./compiler.ts";
import { PocError } from "./error.ts";

const STATE_SCHEMA = 1;
const MAX_COMPRESSED_BYTES = 1_000_000_000;
const MAX_UNCOMPRESSED_BYTES = 2_000_000_000;

type WireSpan = { readonly $span: readonly [number, number, number] };
type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue };

interface WireAdt {
  readonly $: "ADT";
  readonly n: number;
  readonly g: number;
  readonly T: WireValue;
  readonly c: readonly WireConstructor[];
  readonly b?: boolean;
}

interface WireDefinition {
  readonly $: "Def";
  readonly n: number;
  readonly x: number;
  readonly T: WireValue;
  readonly v: WireValue | null;
  readonly e?: WireValue;
  readonly b?: boolean;
  readonly u?: boolean;
  readonly i?: readonly string[];
}

interface WireConstructor {
  readonly k: string;
  readonly n: number;
  readonly T: WireValue;
}

type WireTopLevel = WireAdt | WireDefinition;

interface WireState {
  readonly schema: number;
  readonly sources: readonly string[];
  readonly book: {
    readonly tlds: readonly (readonly [string, WireTopLevel])[];
    readonly ctrs: readonly string[];
    readonly order: readonly string[];
    readonly hols: number;
    readonly open: number;
    readonly tmps: readonly (readonly [string, readonly (readonly [string, string])[]])[];
  };
  readonly seen: readonly (readonly [string, string | null])[];
}

export function encodeBookState(
  runtime: CompilerRuntime,
  state: BookStateLike,
): Buffer {
  try {
    const sources: string[] = [];
    const sourceIds = new Map<string, number>();
    const encodeTerm = (term: PlainTerm): WireValue =>
      encodeValue(term, sources, sourceIds);
    const lower = (term: Parameters<typeof runtime.Bend.term_lower>[0]): WireValue =>
      encodeTerm(runtime.Bend.term_lower(term));
    const normalizeLower = (term: PlainTerm): WireValue =>
      encodeTerm(runtime.Bend.term_lower(runtime.Bend.term_higher(term)));

    const tlds: Array<readonly [string, WireTopLevel]> = [];
    for (const name of Object.keys(state.book.tlds)) {
      const tld = state.book.tlds[name];
      if (tld === undefined) {
        throw new PocError("CODEC", `book.tlds.${name} is missing`);
      }
      tlds.push([name, encodeTopLevel(tld, lower, normalizeLower)]);
    }

    const wire: WireState = {
      schema: STATE_SCHEMA,
      sources,
      book: {
        tlds,
        ctrs: Object.keys(state.book.ctrs),
        order: [...state.book.order],
        hols: state.book.hols,
        open: state.book.open,
        tmps: Object.keys(state.book.tmps).map((name) => [
          name,
          Object.entries(state.book.tmps[name] ?? Object.create(null)),
        ]),
      },
      seen: [...state.seen.entries()],
    };
    return gzipSync(Buffer.from(JSON.stringify(wire), "utf8"), { level: 9 });
  } catch (cause) {
    if (cause instanceof PocError) {
      throw cause;
    }
    throw new PocError("CODEC", "could not encode checked Bend state", {}, { cause });
  }
}

export function decodeBookState(
  runtime: CompilerRuntime,
  compressed: Uint8Array,
): BookStateLike {
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
    throw new PocError("CODEC", "compressed checkpoint exceeds the size limit", {
      bytes: compressed.byteLength,
      limit: MAX_COMPRESSED_BYTES,
    });
  }
  let parsed: unknown;
  try {
    const plain = gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
    parsed = JSON.parse(plain.toString("utf8")) as unknown;
  } catch (cause) {
    throw new PocError("CODEC", "checkpoint is not valid gzip JSON", {}, { cause });
  }

  try {
    const root = record(parsed, "checkpoint");
    integer(root.schema, "checkpoint.schema");
    if (root.schema !== STATE_SCHEMA) {
      throw new PocError("CODEC", "unsupported checkpoint schema", {
        expected: STATE_SCHEMA,
        found: root.schema,
      });
    }
    const sources = stringArray(root.sources, "checkpoint.sources");
    const rawBook = record(root.book, "checkpoint.book");
    const book = runtime.Bend.book_nil();

    for (const [index, rawEntry] of array(rawBook.tlds, "checkpoint.book.tlds").entries()) {
      const pair = tuple(rawEntry, 2, `checkpoint.book.tlds[${index}]`);
      const name = string(pair[0], `checkpoint.book.tlds[${index}][0]`);
      if (Object.hasOwn(book.tlds, name)) {
        throw new PocError("CODEC", `duplicate top-level name ${name}`);
      }
      book.tlds[name] = decodeTopLevel(
        runtime,
        pair[1],
        sources,
        `checkpoint.book.tlds[${index}][1]`,
      );
    }

    const expectedCtrs = stringArray(rawBook.ctrs, "checkpoint.book.ctrs");
    for (const tld of Object.values(book.tlds)) {
      if (tld.$ === "ADT") {
        for (const constructor of tld.c) {
          if (Object.hasOwn(book.ctrs, constructor.k)) {
            throw new PocError("CODEC", `duplicate constructor ${constructor.k}`);
          }
          book.ctrs[constructor.k] = constructor;
        }
      }
    }
    if (
      expectedCtrs.length !== Object.keys(book.ctrs).length ||
      expectedCtrs.some((name) => !Object.hasOwn(book.ctrs, name))
    ) {
      throw new PocError("CODEC", "checkpoint constructor index disagrees with ADTs");
    }

    book.order.push(...stringArray(rawBook.order, "checkpoint.book.order"));
    book.hols = nonNegativeInteger(rawBook.hols, "checkpoint.book.hols");
    book.open = nonNegativeInteger(rawBook.open, "checkpoint.book.open");
    for (const [index, rawEntry] of array(rawBook.tmps, "checkpoint.book.tmps").entries()) {
      const pair = tuple(rawEntry, 2, `checkpoint.book.tmps[${index}]`);
      const name = string(pair[0], `checkpoint.book.tmps[${index}][0]`);
      const table: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [itemIndex, rawItem] of array(
        pair[1],
        `checkpoint.book.tmps[${index}][1]`,
      ).entries()) {
        const item = tuple(rawItem, 2, `checkpoint.book.tmps[${index}][1][${itemIndex}]`);
        const key = string(item[0], "template key");
        if (Object.hasOwn(table, key)) {
          throw new PocError("CODEC", `duplicate template key ${key}`);
        }
        table[key] = string(item[1], "template value");
      }
      book.tmps[name] = table;
    }

    const seen = new Map<string, string | null>();
    for (const [index, rawEntry] of array(root.seen, "checkpoint.seen").entries()) {
      const pair = tuple(rawEntry, 2, `checkpoint.seen[${index}]`);
      const file = string(pair[0], `checkpoint.seen[${index}][0]`);
      const namespace = pair[1] === null
        ? null
        : string(pair[1], `checkpoint.seen[${index}][1]`);
      if (seen.has(file)) {
        throw new PocError("CODEC", `duplicate seen path ${file}`);
      }
      seen.set(file, namespace);
    }
    return { book, seen };
  } catch (cause) {
    if (cause instanceof PocError) {
      throw cause;
    }
    throw new PocError("CODEC", "checkpoint has an invalid shape", {}, { cause });
  }
}

function encodeTopLevel(
  tld: TopLevelLike,
  lower: (term: Parameters<CompilerRuntime["Bend"]["term_lower"]>[0]) => WireValue,
  normalizeLower: (term: PlainTerm) => WireValue,
): WireTopLevel {
  if (tld.$ === "ADT") {
    return optionalBoolean({
      $: "ADT",
      n: tld.n,
      g: tld.g,
      T: lower(tld.T),
      c: tld.c.map((constructor) => ({
        k: constructor.k,
        n: constructor.n,
        T: lower(constructor.T),
      })),
    }, "b", tld.b) as WireAdt;
  }
  let wire: Record<string, unknown> = {
    $: "Def",
    n: tld.n,
    x: tld.x,
    T: lower(tld.T),
    v: tld.v === null ? null : lower(tld.v),
  };
  if (tld.e !== undefined) {
    wire.e = normalizeLower(tld.e);
  }
  wire = optionalBoolean(wire, "b", tld.b);
  wire = optionalBoolean(wire, "u", tld.u);
  if (tld.i !== undefined) {
    wire.i = [...tld.i];
  }
  return wire as unknown as WireDefinition;
}

function decodeTopLevel(
  runtime: CompilerRuntime,
  value: unknown,
  sources: readonly string[],
  location: string,
): TopLevelLike {
  const raw = record(value, location);
  const tag = string(raw.$, `${location}.$`);
  if (tag === "ADT") {
    const constructors = array(raw.c, `${location}.c`).map((item, index) => {
      const source = record(item, `${location}.c[${index}]`);
      return {
        k: string(source.k, `${location}.c[${index}].k`),
        n: nonNegativeInteger(source.n, `${location}.c[${index}].n`),
        T: higher(runtime, source.T, sources, `${location}.c[${index}].T`),
      } satisfies ConstructorLike;
    });
    const result: AdtLike = {
      $: "ADT",
      n: nonNegativeInteger(raw.n, `${location}.n`),
      g: nonNegativeInteger(raw.g, `${location}.g`),
      T: higher(runtime, raw.T, sources, `${location}.T`),
      c: constructors,
    };
    assignOptionalBoolean(result, "b", raw.b, `${location}.b`);
    return result;
  }
  if (tag === "Def") {
    const result: DefinitionLike = {
      $: "Def",
      n: nonNegativeInteger(raw.n, `${location}.n`),
      x: nonNegativeInteger(raw.x, `${location}.x`),
      T: higher(runtime, raw.T, sources, `${location}.T`),
      v: raw.v === null ? null : higher(runtime, raw.v, sources, `${location}.v`),
    };
    if (raw.e !== undefined) {
      const lowered = restoreValue(raw.e, sources, `${location}.e`) as PlainTerm;
      runtime.Bend.term_lower(runtime.Bend.term_higher(lowered));
      result.e = lowered;
    }
    assignOptionalBoolean(result, "b", raw.b, `${location}.b`);
    assignOptionalBoolean(result, "u", raw.u, `${location}.u`);
    if (raw.i !== undefined) {
      result.i = stringArray(raw.i, `${location}.i`);
    }
    return result;
  }
  throw new PocError("CODEC", `unknown top-level tag ${tag}`, { location, tag });
}

function higher(
  runtime: CompilerRuntime,
  value: unknown,
  sources: readonly string[],
  location: string,
): ReturnType<CompilerRuntime["Bend"]["term_higher"]> {
  const lowered = restoreValue(value, sources, location) as PlainTerm;
  const result = runtime.Bend.term_higher(lowered);
  runtime.Bend.term_lower(result);
  return result;
}

function encodeValue(
  value: unknown,
  sources: string[],
  sourceIds: Map<string, number>,
): WireValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PocError("CODEC", "term contains a non-finite number", { value });
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new PocError("CODEC", "lowered term contains a non-data value", {
      type: typeof value,
    });
  }
  if (isSpan(value)) {
    let sourceId = sourceIds.get(value.src);
    if (sourceId === undefined) {
      sourceId = sources.length;
      sources.push(value.src);
      sourceIds.set(value.src, sourceId);
    }
    return { $span: [sourceId, value.beg, value.end] } satisfies WireSpan;
  }
  if (Array.isArray(value)) {
    return value.map((item) => encodeValue(item, sources, sourceIds));
  }
  const output: Record<string, WireValue> = Object.create(null) as Record<string, WireValue>;
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      output[key] = encodeValue(item, sources, sourceIds);
    }
  }
  return output;
}

function restoreValue(value: unknown, sources: readonly string[], location: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
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

function optionalBoolean<T extends Record<string, unknown>>(
  value: T,
  key: string,
  item: boolean | undefined,
): T {
  if (item !== undefined) {
    (value as Record<string, unknown>)[key] = item;
  }
  return value;
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
