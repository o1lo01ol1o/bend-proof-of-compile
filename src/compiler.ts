import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { PocError } from "./error.ts";

export type Namespace = string | null;

export interface SpanLike {
  readonly src: string;
  readonly beg: number;
  readonly end: number;
}

export type PlainTerm = Readonly<Record<string, unknown>>;
export type HigherTerm = Readonly<Record<string, unknown>>;

export interface ConstructorLike {
  k: string;
  n: number;
  T: HigherTerm;
}

export interface AdtLike {
  $: "ADT";
  n: number;
  g: number;
  T: HigherTerm;
  c: ConstructorLike[];
  b?: boolean;
}

export interface DefinitionLike {
  $: "Def";
  n: number;
  x: number;
  T: HigherTerm;
  v: HigherTerm | null;
  e?: PlainTerm;
  b?: boolean;
  u?: boolean;
  i?: string[];
}

export type TopLevelLike = AdtLike | DefinitionLike;

export interface BookLike {
  tlds: Record<string, TopLevelLike>;
  ctrs: Record<string, ConstructorLike>;
  order: string[];
  hols: number;
  open: number;
  tmps: Record<string, Record<string, string>>;
}

export interface BookStateLike {
  readonly book: BookLike;
  readonly seen: Map<string, Namespace>;
}

export interface CheckedBookStateLike extends BookStateLike {
  readonly n0: number;
}

interface BendModule {
  readonly BASE_BEND: string;
  book_nil(): BookLike;
  book_load(
    book: BookLike,
    file: string,
    namespace: string,
    seen: Map<string, Namespace>,
  ): Promise<number>;
  book_valid(book: BookLike, done: number): void;
  term_lower(term: HigherTerm): PlainTerm;
  term_higher(term: PlainTerm): HigherTerm;
  err_show?(error: unknown): string;
}

interface MainModule {
  book_read(file: string, unsafeSeed?: BookStateLike): Promise<CheckedBookStateLike>;
}

interface CompModule {
  readonly SYNTH: string[];
  book_owned(book: BookLike, names?: string[]): void;
  compile_book(book: BookLike): string;
  js_book(book: BookLike): string;
  js_lib(book: BookLike, roots: string[], outputs: string[] | null): string;
  io_base(book: BookLike, term: HigherTerm): unknown;
}

export interface CompilerRuntime {
  readonly bend2Source: string;
  readonly baseFile: string;
  readonly Bend: BendModule;
  readonly Main: MainModule;
  readonly Comp: CompModule;
  bookRead(
    file: string,
    unsafeSeed?: BookStateLike,
    namespace?: string,
  ): Promise<CheckedBookStateLike>;
  compileC(book: BookLike): string;
  compileJs(book: BookLike): string;
  compileLibrary(book: BookLike, roots?: readonly string[]): string;
  formatError(error: unknown): string;
}

export async function loadCompiler(bend2Source: string): Promise<CompilerRuntime> {
  const source = path.resolve(bend2Source);
  const bendPath = path.join(source, "bend.ts");
  const mainPath = path.join(source, "main.ts");
  const compPath = path.join(source, "comp.ts");

  let Bend: BendModule;
  let Main: MainModule;
  let Comp: CompModule;
  try {
    Bend = (await import(pathToFileURL(bendPath).href)) as BendModule;
    Main = (await import(pathToFileURL(mainPath).href)) as MainModule;
    Comp = (await import(pathToFileURL(compPath).href)) as CompModule;
  } catch (cause) {
    throw new PocError(
      "COMPILER_API",
      `could not import the pinned Bend compiler from ${source}`,
      { bend2Source: source },
      { cause },
    );
  }

  if (
    typeof Bend.book_nil !== "function" ||
    typeof Bend.book_load !== "function" ||
    typeof Bend.book_valid !== "function" ||
    typeof Bend.term_lower !== "function" ||
    typeof Bend.term_higher !== "function" ||
    typeof Main.book_read !== "function" ||
    !Array.isArray(Comp.SYNTH) ||
    typeof Comp.book_owned !== "function" ||
    typeof Comp.compile_book !== "function" ||
    typeof Comp.js_book !== "function" ||
    typeof Comp.js_lib !== "function" ||
    typeof Comp.io_base !== "function" ||
    typeof Bend.BASE_BEND !== "string"
  ) {
    throw new PocError(
      "COMPILER_API",
      "the pinned Bend compiler does not expose the required API",
      { bend2Source: source },
    );
  }

  return {
    bend2Source: source,
    baseFile: Bend.BASE_BEND,
    Bend,
    Main,
    Comp,
    async bookRead(file, unsafeSeed, namespace = "") {
      try {
        if (namespace === "") {
          return await Main.book_read(file, unsafeSeed);
        }
        return await bookReadAtNamespace(Bend, Comp, file, namespace, unsafeSeed);
      } catch (cause) {
        throw new PocError(
          "COMPILER_REJECTED",
          formatBendError(Bend, cause),
          { file, namespace },
          { cause },
        );
      }
    },
    compileC(book) {
      try {
        return Comp.compile_book(book);
      } catch (cause) {
        throw new PocError(
          "COMPILER_REJECTED",
          formatBendError(Bend, cause),
          { target: "c" },
          { cause },
        );
      }
    },
    compileJs(book) {
      try {
        return Comp.js_book(book);
      } catch (cause) {
        throw new PocError(
          "COMPILER_REJECTED",
          formatBendError(Bend, cause),
          { target: "js" },
          { cause },
        );
      }
    },
    compileLibrary(book, roots) {
      try {
        const available = [...new Set(book.order)].filter((name) => {
          const topLevel = book.tlds[name];
          return topLevel?.$ === "Def" &&
            topLevel.v !== null &&
            topLevel.b !== true &&
            topLevel.x === 0 &&
            topLevel.i === undefined &&
            Comp.io_base(book, topLevel.T) === null;
        });
        const outputs = roots === undefined ? available : [...roots];
        for (const name of outputs) {
          if (!available.includes(name)) {
            throw new Error(`Bend library root is not exportable: ${name}`);
          }
        }
        return Comp.js_lib(book, outputs, outputs);
      } catch (cause) {
        throw new PocError(
          "COMPILER_REJECTED",
          formatBendError(Bend, cause),
          { target: "js-library" },
          { cause },
        );
      }
    },
    formatError(error) {
      return formatBendError(Bend, error);
    },
  };
}

async function bookReadAtNamespace(
  Bend: BendModule,
  Comp: CompModule,
  file: string,
  namespace: string,
  unsafeSeed?: BookStateLike,
): Promise<CheckedBookStateLike> {
  const book = unsafeSeed === undefined
    ? Bend.book_nil()
    : cloneCheckedBook(Bend, unsafeSeed.book);
  const seen = new Map(unsafeSeed?.seen);
  const done = book.order.length;
  const n0 = await Bend.book_load(book, file, namespace, seen);
  Bend.book_valid(book, done);
  Comp.book_owned(book, Comp.SYNTH);
  const holes = book.hols + book.open;
  if (holes > 0) {
    throw new Error(
      `${holes} TODO${holes === 1 ? "" : "s"} found; the code is incomplete`,
    );
  }
  return { book, seen, n0 };
}

function cloneCheckedBook(Bend: BendModule, source: BookLike): BookLike {
  const book = Bend.book_nil();
  for (const name of Object.keys(source.tlds)) {
    const topLevel = source.tlds[name];
    if (topLevel !== undefined) {
      book.tlds[name] = { ...topLevel };
    }
  }
  Object.assign(book.ctrs, source.ctrs);
  for (const name of Object.keys(source.tmps)) {
    book.tmps[name] = { ...source.tmps[name] };
  }
  book.order.push(...source.order);
  return book;
}

function formatBendError(Bend: BendModule, error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "$" in error &&
    (error as { $?: unknown }).$ === "Err" &&
    typeof Bend.err_show === "function"
  ) {
    return Bend.err_show(error);
  }
  return error instanceof Error ? error.message : String(error);
}
