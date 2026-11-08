// The stored-body law: a program whose checked bodies went through the term
// table compiles to the same C and JS as the program the checker built.
// Every fixture imports Base, so Base's bodies are covered too. The pack's
// own path (gzip, interned names, lazy restore) is covered by
// test/codec.test.ts and by the acceptance histories' `poc build` against
// `bend -o`.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { StoredTerms, TermTable, type TermKernel } from "../src/term-table.ts";

const source = process.env.POC_BEND2_SOURCE;
if (source === undefined || source.length === 0) {
  throw new Error("POC_BEND2_SOURCE is required");
}
type Book = { tlds: Record<string, { $: string; e?: unknown; v?: unknown }>; order: string[] };
const Bend = (await import(pathToFileURL(path.join(source, "bend.ts")).href)) as TermKernel & {
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

// Every body of a book through one table, as a pack stores them; returns the
// table and each stored definition's root.
function store(book: Book): { table: TermTable; roots: Array<[Book["tlds"][string], number]> } {
  const table = new TermTable(Bend);
  const roots: Array<[Book["tlds"][string], number]> = [];
  for (const record of Object.values(book.tlds)) {
    if (record.$ === "Def" && record.e !== undefined) {
      roots.push([record, table.body(record.e as object)]);
    }
  }
  return { table, roots };
}

// The table as a pack writes it, and reads it back.
const roundTrip = (table: TermTable): StoredTerms => new StoredTerms(Bend, JSON.parse(JSON.stringify(table.nodes)) as unknown[]);

describe("stored bodies", () => {
  for (const name of fs.readdirSync(fixtures).filter((file) => file.endsWith(".bend")).sort()) {
    test(`${name}: C and JS from restored bodies equal the checked program's`, async () => {
      const book = await checked(path.join(fixtures, name));
      const c = Comp.compile_book(book);
      const js = Comp.js_book(book);
      const { table, roots } = store(book);
      const stored = roundTrip(table);
      for (const [record, root] of roots) {
        record.e = stored.body(root);
      }
      expect(roots.length).toBeGreaterThan(300);
      expect(Comp.compile_book(book)).toBe(c);
      expect(Comp.js_book(book)).toBe(js);
    });
  }

  // The table has no spans, and the kernel's raise reduces a redex it builds
  // (App of a Lam), so a cell value holding one is stored reduced after a
  // round trip: an equal term, and the same program (above). From then on
  // the encoding is stable, and every definition keeps its body.
  test("the encoding is stable after one round trip", async () => {
    const book = await checked(path.join(fixtures, "PolyRec.bend"));
    const first = store(book);
    const once = roundTrip(first.table);
    for (const [record, root] of first.roots) {
      record.e = once.body(root);
    }
    const second = store(book);
    const twice = roundTrip(second.table);
    for (const [record, root] of second.roots) {
      record.e = twice.body(root);
    }
    const third = store(book);
    expect(second.roots.length).toBe(first.roots.length);
    expect(JSON.stringify(third.table.nodes)).toBe(JSON.stringify(second.table.nodes));
    expect(third.roots.map(([, root]) => root)).toEqual(second.roots.map(([, root]) => root));
  });

  // Equal types are one node: a module's bodies are mostly copies of the
  // same types, and the table holds each once.
  test("the table shares equal types among bodies", async () => {
    const book = await checked(path.join(fixtures, "PolyRec.bend"));
    const { table, roots } = store(book);
    let cells = 0;
    for (const node of table.nodes) {
      if (typeof node === "object" && node !== null && !Array.isArray(node) && "L" in node) {
        cells += 1;
      }
    }
    expect(roots.length).toBeGreaterThan(300);
    expect(cells).toBeGreaterThan(0);
    expect(table.nodes.length).toBeLessThan(cells * 8);
  });
});

// Through real packs: a state restored from the packs a check sealed compiles
// to the checked program, with no re-elaboration.
describe("restored states", async () => {
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

  test("C and JS of a restored state equal the checked program's", () => {
    let state = { book: runtime.Bend.book_nil(), seen: new Map<string, string | null>() };
    for (const wire of wires) {
      const child = { book: runtime.Main.book_over(state.book), seen: new Map(state.seen) };
      decodePackWire(runtime, wire).apply(child);
      state = child;
    }
    expect(runtime.emit(state.book, "c")).toBe(c);
    expect(runtime.emit(state.book, "js")).toBe(js);
  }, 120_000);
});
