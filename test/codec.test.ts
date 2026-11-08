// Pack codec laws and golden vectors.
//
// The fixture is two Base-free files: P declares a datatype, a function and a
// law; A imports P and fills the law. Each is one sealed boundary, so the
// check produces two packs, each a state text and an elaboration text. Golden
// vectors pin both (with the fixture directory abstracted); regenerate them
// deliberately with POC_UPDATE_GOLDEN=1 when the checker or the pack schema
// changes.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";

import { decodePack, decodePackWire, encodePack, encodePackWire, referencesOf, type PackWire } from "../src/codec.ts";
import { loadCompiler, type BookStateLike, type CheckGroup, type SourceFileLike } from "../src/compiler.ts";

const source = process.env.POC_BEND2_SOURCE;
if (source === undefined) {
  throw new Error("POC_BEND2_SOURCE is required");
}
const runtime = await loadCompiler(source);
const fixture = fs.realpathSync(path.join(import.meta.dir, "fixtures", "pack"));
const golden = path.join(import.meta.dir, "golden");
const DIR = "<fixture>";

interface Sealed {
  readonly parent: BookStateLike;
  readonly child: BookStateLike;
  readonly last: number;
  readonly wire: PackWire;
}

async function checkFixture(): Promise<Sealed[]> {
  const order = await runtime.loadSteps(path.join(fixture, "A.bend"), "entry");
  const groups: CheckGroup[] = [...order.imports, order.entry].map((step, index) => ({
    steps: [step],
    key: String(index).padStart(64, "0"),
  }));
  const sealed: Sealed[] = [];
  await runtime.check(order.entry.path, "", groups, undefined, (key, parent, child, last) => {
    const parentKey = sealed.length === 0 ? null : groups[sealed.length - 1]?.key ?? null;
    sealed.push({ parent, child, last, wire: encodePackWire(runtime, parentKey, parent, child, last) });
  });
  return sealed;
}

const abstract = (wire: string): string => wire.split(fixture).join(DIR);
const concrete = (wire: string): string => wire.split(DIR).join(fixture);
const goldenFile = (index: number, part: keyof PackWire): string =>
  path.join(golden, part === "state" ? `pack-v8-${index}.json` : `pack-v8-${index}.elaboration.json`);
const decode = (wire: PackWire) => decodePackWire(runtime, wire.state, () => wire.elaboration);

describe("packs", async () => {
  const sealed = await checkFixture();

  test("golden vectors pin the wire texts", () => {
    expect(sealed.length).toBe(2);
    for (const [index, pack] of sealed.entries()) {
      for (const part of ["state", "elaboration"] as const) {
        const file = goldenFile(index, part);
        if (process.env.POC_UPDATE_GOLDEN === "1") {
          fs.writeFileSync(file, `${abstract(pack.wire[part])}\n`);
        }
        expect(abstract(pack.wire[part])).toBe(fs.readFileSync(file, "utf8").trimEnd());
      }
    }
  });

  test("a pack's elaboration holds every checked body, read on first use", () => {
    let parent: BookStateLike = { book: runtime.Bend.book_nil(), seen: new Map() };
    for (const pack of sealed) {
      const child: BookStateLike = { book: runtime.Main.book_over(parent.book), seen: new Map(parent.seen) };
      let reads = 0;
      decodePackWire(runtime, pack.wire.state, () => {
        reads += 1;
        return pack.wire.elaboration;
      }).apply(child);
      let bodies = 0;
      for (const name of Object.keys(pack.child.book.tlds)) {
        const checked = pack.child.book.tlds[name];
        const restored = child.book.tlds[name];
        if (checked?.$ === "Def" && checked.e !== undefined) {
          expect(reads).toBe(bodies === 0 ? 0 : 1);
          expect(restored?.$ === "Def" ? restored.e : undefined).toBeDefined();
          bodies += 1;
        }
      }
      // Read once per pack, on the first body, and never otherwise.
      expect(reads).toBe(bodies === 0 ? 0 : 1);
      parent = child;
    }
  });

  test("decode then encode is the identity on each golden pack", () => {
    let parent: BookStateLike = { book: runtime.Bend.book_nil(), seen: new Map() };
    for (let index = 0; index < sealed.length; index += 1) {
      const wire: PackWire = {
        state: concrete(fs.readFileSync(goldenFile(index, "state"), "utf8").trimEnd()),
        elaboration: concrete(fs.readFileSync(goldenFile(index, "elaboration"), "utf8").trimEnd()),
      };
      const pack = decode(wire);
      const child: BookStateLike = { book: runtime.Main.book_over(parent.book), seen: new Map(parent.seen) };
      pack.apply(child);
      expect(encodePackWire(runtime, pack.parent, parent, child, pack.last)).toEqual(wire);
      parent = child;
    }
  });

  test("gzip framing round-trips", () => {
    const [first] = sealed;
    if (first === undefined) {
      throw new Error("no pack");
    }
    const bytes = encodePack(runtime, null, first.parent, first.child, first.last);
    const child: BookStateLike = { book: runtime.Main.book_over(first.parent.book), seen: new Map(first.parent.seen) };
    decodePack(runtime, bytes.state, () => bytes.elaboration).apply(child);
    expect(encodePackWire(runtime, null, first.parent, child, first.last)).toEqual(first.wire);
  });

  test("a restored record's summary is the checked record's", () => {
    let parent: BookStateLike = { book: runtime.Bend.book_nil(), seen: new Map() };
    for (const pack of sealed) {
      const child: BookStateLike = { book: runtime.Main.book_over(parent.book), seen: new Map(parent.seen) };
      decode(pack.wire).apply(child);
      for (const name of Object.keys(pack.child.book.tlds)) {
        const checked = pack.child.book.tlds[name];
        const restored = child.book.tlds[name];
        if (checked === undefined || restored === undefined) {
          throw new Error(`missing ${name}`);
        }
        expect(referencesOf(runtime, restored)).toEqual(referencesOf(runtime, checked));
      }
      parent = child;
    }
  });

  test("a restored table stays writable through a child", () => {
    const [first] = sealed;
    if (first === undefined) {
      throw new Error("no pack");
    }
    const restored: BookStateLike = { book: runtime.Bend.book_nil(), seen: new Map() };
    decode(first.wire).apply(restored);
    const child = runtime.Main.book_over(restored.book);
    const law = child.tlds["P:later"];
    if (law === undefined) {
      throw new Error("the fixture's law is missing");
    }
    child.tlds["P:later"] = { ...law };
    expect(Object.hasOwn(child.tlds, "P:later")).toBe(true);
    expect(restored.book.tlds["P:later"]).toBe(law);
  });

  test("source identity preserves content deduplication and encoding-local IDs", () => {
    const parent: BookStateLike = { book: runtime.Bend.book_nil(), seen: new Map() };
    const child: BookStateLike = { book: runtime.Main.book_over(parent.book), seen: new Map() };
    const shared: { str: string; ns: string; al: Record<string, string> } = {
      str: "source\n".repeat(1000), ns: "P", al: { z: "Z", a: "A" },
    };
    const equal: SourceFileLike = { str: shared.str, ns: "P", al: { a: "A", z: "Z" } };
    const otherNamespace: SourceFileLike = { ...shared, ns: "Q" };
    const otherAlias: SourceFileLike = { ...shared, al: { a: "Different", z: "Z" } };
    const files = [shared, shared, equal, shared, otherNamespace, otherAlias, equal];
    for (const [index, file] of files.entries()) {
      const name = `P:d${index}`;
      child.book.tlds[name] = {
        $: "Def", n: index, x: 0,
        T: runtime.Bend.term_higher({ $: "Set", s: { file, beg: 0, end: 1 } }), v: null,
      };
      child.book.order.push(name);
    }
    const baseline = encodePackWire(runtime, null, parent, child, 0).state;
    type SourceWire = {
      sources: SourceFileLike[];
      tlds: [string, { t: string }][];
    };
    // A record's terms travel as one compressed blob.
    const spanOf = (record: { t: string }): [number, number, number] =>
      (JSON.parse(inflateRawSync(Buffer.from(record.t, "base64")).toString("utf8")) as { T: { s: { $span: [number, number, number] } } }).T.s.$span;
    const wire: SourceWire = JSON.parse(baseline);
    expect(wire.sources).toEqual([
      { str: shared.str, ns: "P", al: { a: "A", z: "Z" } },
      { str: shared.str, ns: "Q", al: { a: "A", z: "Z" } },
      { str: shared.str, ns: "P", al: { a: "Different", z: "Z" } },
    ]);
    expect(wire.tlds.map(([, record]) => spanOf(record))).toEqual(
      [0, 0, 0, 0, 1, 2, 0].map((id) => [id, 0, 1]),
    );
    expect(encodePackWire(runtime, null, parent, child, 0).state).toBe(baseline);
    // A later encoding observes changed source contents, namespaces and aliases.
    shared.str = "changed source\n";
    shared.ns = "Changed";
    shared.al = { c: "C" };
    const changed: SourceWire = JSON.parse(encodePackWire(runtime, null, parent, child, 0).state);
    expect(changed.sources).toEqual([
      shared,
      { str: equal.str, ns: "P", al: { a: "A", z: "Z" } },
      { str: equal.str, ns: "Q", al: { a: "A", z: "Z" } },
      { str: equal.str, ns: "P", al: { a: "Different", z: "Z" } },
    ]);
    expect(changed.tlds.map(([, record]) => spanOf(record)[0])).toEqual([0, 0, 1, 0, 2, 3, 1]);
  });

  test("malformed packs are rejected", () => {
    const [first] = sealed;
    if (first === undefined) {
      throw new Error("no pack");
    }
    const wire = JSON.parse(first.wire.state) as Record<string, unknown>;
    const elaboration = JSON.parse(first.wire.elaboration) as { schema: number; nodes: unknown[]; roots: Array<[string, number]> };
    const reject = (changed: Record<string, unknown>): void => {
      expect(() => decodePackWire(runtime, JSON.stringify(changed), () => first.wire.elaboration)).toThrow();
    };
    reject({ ...wire, schema: 2 });
    reject({ ...wire, schema: 7 });
    reject({ ...wire, ctrs: [] });
    reject({ ...wire, last: -1 });
    reject({ ...wire, tlds: [...(wire.tlds as unknown[]), ...(wire.tlds as unknown[])] });
    expect(() => decodePackWire(runtime, "{", () => first.wire.elaboration)).toThrow();
    // The elaboration names every valued definition of its pack, and only
    // those; a fault there is found when a body is read (force reads all).
    const tlds = wire.tlds as Array<[string, Record<string, unknown>]>;
    const valued = tlds.find(([, record]) => record.$ === "Def" && record.v === true)?.[0];
    const declared = tlds.find(([, record]) => record.$ === "Def" && record.v === false)?.[0];
    if (valued === undefined || declared === undefined) {
      throw new Error("the fixture has no valued definition or no declaration");
    }
    expect(elaboration.roots.map(([name]) => name)).toContain(valued);
    const withElaboration = (changed: object) => decodePackWire(runtime, first.wire.state, () => JSON.stringify(changed));
    expect(() => withElaboration({ ...elaboration, schema: 7 }).force()).toThrow();
    // A record whose terms are not valid deflate, or disagree with it, is
    // refused when read.
    const corrupt = tlds.map(([name, record]) => [name, name === valued ? { ...record, t: "not base64 deflate" } : record]);
    expect(() => decodePackWire(runtime, JSON.stringify({ ...wire, tlds: corrupt }), () => first.wire.elaboration).force()).toThrow();
    const swapped = tlds.map(([name, record]) => [name, name === valued ? { ...record, v: false } : record]);
    expect(() => decodePackWire(runtime, JSON.stringify({ ...wire, tlds: swapped }), () => first.wire.elaboration).force()).toThrow();
    expect(() => withElaboration({ ...elaboration, roots: elaboration.roots.filter(([name]) => name !== valued) }).force()).toThrow();
    expect(() => withElaboration({ ...elaboration, roots: [...elaboration.roots, [declared, 0]] }).force()).toThrow();
    expect(() => withElaboration({ ...elaboration, roots: [...elaboration.roots, [valued, 0]] }).force()).toThrow();
    // A check never reads the elaboration.
    const untouched = decodePackWire(runtime, first.wire.state, () => {
      throw new Error("the elaboration was read");
    });
    const state: BookStateLike = { book: runtime.Bend.book_nil(), seen: new Map() };
    untouched.apply(state);
    for (const name of Object.keys(state.book.tlds)) {
      const record = state.book.tlds[name];
      expect(record?.$).toBeDefined();
      void record?.T;
    }
  });
});
