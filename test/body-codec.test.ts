// The stored-body law: a program whose checked bodies went through the body
// codec compiles to the same C and JS as the program the checker built.
// Every fixture imports Base, so Base's bodies are covered too. The pack's
// own path (spans through its source table, gzip, restore) is covered by
// test/codec.test.ts and by the acceptance histories' `poc build` against
// `bend -o`.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { decodeBody, encodeBody, type BodyKernel } from "../src/body-codec.ts";

const source = process.env.POC_BEND2_SOURCE;
if (source === undefined || source.length === 0) {
  throw new Error("POC_BEND2_SOURCE is required");
}
type Book = { tlds: Record<string, { $: string; e?: unknown }>; order: string[] };
const Bend = (await import(pathToFileURL(path.join(source, "bend.ts")).href)) as BodyKernel & {
  book_nil(): Book;
  book_load(book: Book, file: string, ns: string, seen: Map<string, string | null>): Promise<number>;
  book_valid(book: Book, done: number): void;
};
const Comp = (await import(pathToFileURL(path.join(source, "comp.ts")).href)) as {
  compile_book(book: Book): string;
  js_book(book: Book): string;
};

const fixtures = path.join(import.meta.dir, "fixtures", "bodies");

async function checked(file: string): Promise<Book> {
  const book = Bend.book_nil();
  await Bend.book_load(book, file, "", new Map());
  Bend.book_valid(book, 0);
  return book;
}

describe("stored bodies", () => {
  for (const name of fs.readdirSync(fixtures).filter((file) => file.endsWith(".bend")).sort()) {
    test(`${name}: C and JS from restored bodies equal the checked program's`, async () => {
      const book = await checked(path.join(fixtures, name));
      const c = Comp.compile_book(book);
      const js = Comp.js_book(book);
      let bodies = 0;
      for (const record of Object.values(book.tlds)) {
        if (record.$ === "Def" && record.e !== undefined) {
          record.e = decodeBody(Bend, encodeBody(Bend, record.e));
          bodies += 1;
        }
      }
      expect(bodies).toBeGreaterThan(300);
      expect(Comp.compile_book(book)).toBe(c);
      expect(Comp.js_book(book)).toBe(js);
    });
  }

  // A wire's spans are the checker's span objects (their file is the parser
  // state); compare them by source text and position, as the pack writes them.
  const text = (wire: unknown): string => {
    const files = new Map<object, number>();
    return JSON.stringify(wire, (key, value: unknown) => {
      const span = value as { file?: object; beg?: number; end?: number } | null;
      if (key === "s" && typeof span === "object" && span?.file !== undefined) {
        if (!files.has(span.file)) {
          files.set(span.file, files.size);
        }
        return [files.get(span.file), span.beg, span.end];
      }
      return value;
    });
  };

  // The kernel's raise reduces a redex it builds (App of a Lam), so a cell
  // value holding one is stored reduced after a round trip: an equal term,
  // and the same program (above). From then on the encoding is stable.
  test("the encoding is stable after one round trip", async () => {
    const book = await checked(path.join(fixtures, "PolyRec.bend"));
    let bodies = 0;
    for (const record of Object.values(book.tlds)) {
      if (record.$ === "Def" && record.e !== undefined) {
        const once = encodeBody(Bend, decodeBody(Bend, encodeBody(Bend, record.e)));
        expect(text(encodeBody(Bend, decodeBody(Bend, once)))).toBe(text(once));
        bodies += 1;
      }
    }
    expect(bodies).toBeGreaterThan(300);
  });
});

// A body over the codec's budget is not stored, and a build re-elaborates the
// reachable ones by a replay. Whatever mix of stored and missing bodies a
// restored state holds, it compiles to the checked program. The states here
// are real packs (Base, then the program) with bodies removed from the wire,
// as the budget removes them.
describe("bodies not stored", async () => {
  const { loadCompiler } = await import("../src/compiler.ts");
  const { decodePackWire, encodePackWire } = await import("../src/codec.ts");
  const runtime = await loadCompiler(source);
  const entry = path.join(fixtures, "PolyRec.bend");
  const order = await runtime.loadSteps(entry, "entry");
  const groups = [...order.imports, order.entry].map((step, index) => ({ steps: [step], key: String(index).padStart(64, "0") }));
  const wires: string[] = [];
  await runtime.check(order.entry.path, "", groups, undefined, (_key, parent, child, last) => {
    wires.push(encodePackWire(runtime, null, parent, child, last));
  });
  const book = await checked(entry);
  const c = Comp.compile_book(book);
  const js = Comp.js_book(book);
  for (const [label, keep] of [
    ["none stored", (_: number) => false],
    ["every other one stored", (index: number) => index % 2 === 0],
  ] as const) {
    test(`${label}: C and JS equal the checked program's`, () => {
      let index = 0;
      let state = { book: runtime.Bend.book_nil(), seen: new Map<string, string | null>() };
      for (const wire of wires) {
        const pack = JSON.parse(wire) as { tlds: Array<[string, { e?: unknown }]> };
        for (const [, record] of pack.tlds) {
          if (record.e !== undefined && !keep(index++)) {
            delete record.e;
          }
        }
        const child = { book: runtime.Main.book_over(state.book), seen: new Map(state.seen) };
        decodePackWire(runtime, JSON.stringify(pack)).apply(child);
        state = child;
      }
      expect(runtime.emitRestored(state, "c")).toBe(c);
      expect(runtime.emitRestored(state, "js")).toBe(js);
    }, 120_000);
  }
});
