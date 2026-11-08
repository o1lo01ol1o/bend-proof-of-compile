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
