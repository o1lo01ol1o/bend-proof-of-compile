// Pack codec laws and golden vectors.
//
// The fixture is two Base-free files: P declares a datatype, a function and a
// law; A imports P and fills the law. Each is one sealed boundary, so the
// check produces two packs. Golden vectors pin their wire text (with the
// fixture directory abstracted); regenerate them deliberately with
// POC_UPDATE_GOLDEN=1 when the checker or the pack schema changes.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { decodePack, decodePackWire, encodePack, encodePackWire, referencesOf } from "../src/codec.ts";
import { loadCompiler, type BookStateLike, type CheckGroup } from "../src/compiler.ts";

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
  readonly wire: string;
}

async function checkFixture(): Promise<Sealed[]> {
  const order = await runtime.loadSteps(path.join(fixture, "A.bend"));
  const groups: CheckGroup[] = [...order.imports, order.entry].map((step, index) => ({
    steps: [step],
    key: String(index).padStart(64, "0"),
  }));
  const sealed: Sealed[] = [];
  await runtime.check(order.entry.path, groups, undefined, (key, parent, child, last) => {
    const parentKey = sealed.length === 0 ? null : groups[sealed.length - 1]?.key ?? null;
    sealed.push({ parent, child, last, wire: encodePackWire(runtime, parentKey, parent, child, last) });
  });
  return sealed;
}

const abstract = (wire: string): string => wire.split(fixture).join(DIR);
const concrete = (wire: string): string => wire.split(DIR).join(fixture);

describe("packs", async () => {
  const sealed = await checkFixture();

  test("golden vectors pin the wire text", () => {
    expect(sealed.length).toBe(2);
    for (const [index, pack] of sealed.entries()) {
      const file = path.join(golden, `pack-v3-${index}.json`);
      if (process.env.POC_UPDATE_GOLDEN === "1") {
        fs.writeFileSync(file, `${abstract(pack.wire)}\n`);
      }
      expect(abstract(pack.wire)).toBe(fs.readFileSync(file, "utf8").trimEnd());
    }
  });

  test("a pack holds no elaborations", () => {
    for (const pack of sealed) {
      expect(pack.wire.includes('"e":')).toBe(false);
    }
  });

  test("decode then encode is the identity on each golden pack", () => {
    let parent: BookStateLike = { book: runtime.Bend.book_nil(), seen: new Map() };
    for (let index = 0; index < sealed.length; index += 1) {
      const text = concrete(fs.readFileSync(path.join(golden, `pack-v3-${index}.json`), "utf8").trimEnd());
      const pack = decodePackWire(runtime, text);
      const child: BookStateLike = { book: runtime.Main.book_over(parent.book), seen: new Map(parent.seen) };
      pack.apply(child);
      expect(encodePackWire(runtime, pack.parent, parent, child, pack.last)).toBe(text);
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
    decodePack(runtime, bytes).apply(child);
    expect(encodePackWire(runtime, null, first.parent, child, first.last)).toBe(first.wire);
  });

  test("a restored record's summary is the checked record's", () => {
    let parent: BookStateLike = { book: runtime.Bend.book_nil(), seen: new Map() };
    for (const pack of sealed) {
      const child: BookStateLike = { book: runtime.Main.book_over(parent.book), seen: new Map(parent.seen) };
      decodePackWire(runtime, pack.wire).apply(child);
      for (const name of Object.keys(pack.child.book.tlds)) {
        const checked = pack.child.book.tlds[name];
        const restored = child.book.tlds[name];
        if (checked === undefined || restored === undefined) {
          throw new Error(`missing ${name}`);
        }
        expect(restored).not.toHaveProperty("e");
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
    decodePackWire(runtime, first.wire).apply(restored);
    const child = runtime.Main.book_over(restored.book);
    const law = child.tlds["P.later"];
    if (law === undefined) {
      throw new Error("the fixture's law is missing");
    }
    child.tlds["P.later"] = { ...law };
    expect(Object.hasOwn(child.tlds, "P.later")).toBe(true);
    expect(restored.book.tlds["P.later"]).toBe(law);
  });

  test("malformed packs are rejected", () => {
    const [first] = sealed;
    if (first === undefined) {
      throw new Error("no pack");
    }
    const wire = JSON.parse(first.wire) as Record<string, unknown>;
    const reject = (changed: Record<string, unknown>): void => {
      expect(() => decodePackWire(runtime, JSON.stringify(changed))).toThrow();
    };
    reject({ ...wire, schema: 2 });
    reject({ ...wire, ctrs: [] });
    reject({ ...wire, last: -1 });
    reject({ ...wire, tlds: [...(wire.tlds as unknown[]), ...(wire.tlds as unknown[])] });
    expect(() => decodePackWire(runtime, "{")).toThrow();
  });
});
