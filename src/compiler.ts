import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { namesOf, summaryOf } from "./codec.ts";
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

type LoadHook = (real: string, namespace: string, text: string) => boolean | void;

interface BendModule {
  readonly BASE_BEND: string;
  book_nil(): BookLike;
  book_load(
    book: BookLike,
    file: string,
    namespace: string,
    seen: Map<string, Namespace>,
    span?: unknown,
    on?: LoadHook,
  ): Promise<number>;
  book_valid(book: BookLike, done: number, only?: Set<string>): void;
  term_lower(term: HigherTerm): PlainTerm;
  term_higher(term: PlainTerm): HigherTerm;
  err_show?(error: unknown): string;
}

interface MainModule {
  book_read(
    file: string,
    unsafeSeed?: BookStateLike,
    on?: LoadHook,
  ): Promise<CheckedBookStateLike>;
  book_over(parent: BookLike): BookLike;
  book_flat(book: BookLike): BookLike;
}

interface CompModule {
  readonly SYNTH: string[];
  book_owned(book: BookLike, names?: string[]): void;
  compile_book(book: BookLike): string;
  js_book(book: BookLike): string;
  js_lib(book: BookLike, roots: string[], outputs: string[] | null): string;
  io_base(book: BookLike, term: HigherTerm): unknown;
}

// One file of the checker's load order: its realpath, its namespace, and the
// text the checker parses.
export interface LoadStep {
  readonly path: string;
  readonly namespace: string;
  readonly text: string;
}

export type EntryRule =
  | { readonly $: "PlainEntry" }
  | { readonly $: "ProofEntry"; readonly laws: string | null };

export interface LoadOrder {
  readonly imports: readonly LoadStep[];
  readonly entry: LoadStep;
  readonly rule: EntryRule;
}

export type FillFlag = "FillForeign" | "FillUnsafe";

export interface LateFill {
  readonly declared: number;
  readonly filled: number;
  readonly flags: readonly FillFlag[];
}

export type Target = "js" | "c";

export type Role = "entry" | "module";

// The namespace a sibling importer gives a file: the loader's own
// computation for `import ./X.bend` from a file loaded under "" (bend.ts
// book_load: sub = join(dirname(ns), normalize(rel)) without ".bend").
export function moduleNamespace(file: string): string {
  const name = path.basename(file);
  if (!name.endsWith(".bend")) {
    throw new PocError("CLI_USAGE", `a module is a .bend file: ${file}`);
  }
  const rel = path.posix.normalize(`./${name}`);
  return path.posix.join(path.posix.dirname(""), rel).replace(/\.bend$/, "");
}

export interface Verdict {
  readonly todos: number;
  readonly reliant: readonly string[];
}

export interface CheckGroup {
  readonly steps: readonly LoadStep[];
  readonly key: string;
}

export interface CompilerRuntime {
  readonly bend2Source: string;
  readonly baseFile: string;
  readonly Bend: BendModule;
  readonly Main: MainModule;
  readonly Comp: CompModule;
  // A cold check of one file, as `bend FILE --check-only` does it.
  bookRead(file: string): Promise<CheckedBookStateLike>;
  // The load order, walked by the checker's loader without parsing, with the
  // root loaded as the entry or as a module (see moduleNamespace).
  loadSteps(entry: string, role: Role): Promise<LoadOrder>;
  // Parses, without checking, the load order rooted at `root`, which must be
  // `steps`, and reports every law filled in a later step than its own.
  loadFills(root: string, namespace: string, steps: readonly LoadStep[]): Promise<LateFill[]>;
  // Checks `groups` in order, each in a book_over child of the state before
  // it, and passes each checked state to `seal` with `last`, the order index
  // where the group's last file begins. The result is the last state, whose
  // tables stay chained to the seed's.
  check(
    root: string,
    namespace: string,
    groups: readonly CheckGroup[],
    seed: BookStateLike | undefined,
    seal: (key: string, parent: BookStateLike, child: BookStateLike, last: number) => void,
  ): Promise<{ readonly state: BookStateLike; readonly last: number }>;
  // The final judgment of an entry's state, as `book_read` and the checker's
  // report make it: names the compiler owns (a rejection), the count of
  // holes and open laws, and the entry's own claims that rely on @unsafe or
  // foreign code. `n0` is where the entry's claims begin in the order.
  verdict(state: BookStateLike, n0: number): Verdict;
  // The artifact of a state whose restored records carry no elaborations:
  // what `main` reaches is re-elaborated by a replay of the order (5).
  emitRestored(state: BookStateLike, target: Target): string;
  // The artifact of a state checked in this process from nothing.
  emit(book: BookLike, target: Target): string;
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
    typeof Main.book_over !== "function" ||
    typeof Main.book_flat !== "function" ||
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

  const rejected = (cause: unknown, details: Readonly<Record<string, unknown>>): PocError =>
    cause instanceof PocError
      ? cause
      : new PocError("COMPILER_REJECTED", formatBendError(Bend, cause), details, { cause });

  const emit = (book: BookLike, target: Target): string => {
    try {
      return target === "js" ? Comp.js_book(book) : Comp.compile_book(book);
    } catch (cause) {
      throw rejected(cause, { target });
    }
  };

  // The checker's report (main.ts cli_report), over summaries, so restored
  // records need neither elaborations nor raising: the entry's own claims
  // that are @unsafe or foreign, or whose types or elaboration name, through
  // any chain of references, a record that is.
  const reliant = (book: BookLike, n0: number): string[] => {
    const own = [...new Set(book.order.slice(n0))];
    const bad = new Set(namesOf(book.tlds).filter(
      (name) => summaryOf(runtime, book.tlds, name)?.promise === true,
    ));
    const uses = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const queue = bad.size === 0 ? [] : own.slice(); queue.length > 0;) {
      const name = queue.pop() as string;
      const summary = summaryOf(runtime, book.tlds, name);
      if (summary !== undefined && !seen.has(name)) {
        seen.add(name);
        for (const reference of summary.refs) {
          const users = uses.get(reference) ?? [];
          users.push(name);
          uses.set(reference, users);
          queue.push(reference);
        }
      }
    }
    for (const name of bad) {
      uses.get(name)?.forEach((user) => bad.add(user));
    }
    return own.filter((name) => bad.has(name));
  };

  // Re-elaboration for compilation after restore (spec 5, the chosen next
  // step). The emitters compile what `main` reaches through elaborations, so
  // `only` is what `main` reaches through the records' summaries, closed
  // under the callers of every template instance in it: an instance was
  // elaborated when its earliest caller minted it, at that event's view, and
  // replaying that caller re-elaborates it there. The replay book hides every
  // event and reveals it in order, as a cold check does; instances are all
  // present from the start (their names are fixed by the instance tables).
  const replay = (book: BookLike): BookLike => {
    const instances = new Set(Object.values(book.tmps).flatMap((table) => Object.values(table)));
    const refs = (name: string): readonly string[] => summaryOf(runtime, book.tlds, name)?.refs ?? [];
    const callers = new Map<string, string[]>();
    for (const name of namesOf(book.tlds)) {
      for (const reference of refs(name)) {
        const list = callers.get(reference) ?? [];
        list.push(name);
        callers.set(reference, list);
      }
    }
    const only = new Set<string>();
    for (const queue = ["main"]; queue.length > 0;) {
      const name = queue.pop() as string;
      if (only.has(name)) {
        continue;
      }
      only.add(name);
      queue.push(...refs(name));
      if (instances.has(name)) {
        queue.push(...(callers.get(name) ?? []));
      }
    }
    const base = Object.create(null) as BookLike["tlds"];
    for (const name of instances) {
      const tld = book.tlds[name];
      if (tld !== undefined) {
        base[name] = tld;
      }
    }
    const events = Object.create(base) as BookLike["tlds"];
    for (const name of new Set(book.order)) {
      const tld = book.tlds[name];
      if (tld === undefined) {
        throw new PocError("CODEC", `the restored state has no record for ${name}`);
      }
      events[name] = tld;
    }
    const tmps = Object.create(null) as BookLike["tmps"];
    for (const [name, table] of Object.entries(book.tmps)) {
      tmps[name] = Object.assign(Object.create(null) as Record<string, string>, table);
    }
    const again: BookLike = {
      tlds: events,
      ctrs: Object.create(null) as BookLike["ctrs"],
      order: [...book.order],
      hols: 0,
      open: 0,
      tmps,
    };
    Bend.book_valid(again, 0, only);
    return Main.book_flat(again);
  };

  const runtime: CompilerRuntime = {
    bend2Source: source,
    baseFile: Bend.BASE_BEND,
    Bend,
    Main,
    Comp,
    async bookRead(file) {
      try {
        return await Main.book_read(file);
      } catch (cause) {
        throw rejected(cause, { file });
      }
    },
    async loadSteps(entry, role) {
      const steps: LoadStep[] = [];
      const namespace = role === "entry" ? "" : moduleNamespace(entry);
      try {
        await Bend.book_load(Bend.book_nil(), entry, namespace, new Map(), undefined, (real, namespace, text) => {
          steps.push({ path: real, namespace, text });
          return true;
        });
      } catch (walkError) {
        // The walk parses nothing, so it can meet a load error past a parse
        // error that a cold check reports first. Report the cold one.
        try {
          await Bend.book_load(Bend.book_nil(), entry, namespace, new Map());
        } catch (cause) {
          throw rejected(cause, { entry });
        }
        throw rejected(walkError, { entry });
      }
      const entryStep = steps.pop();
      if (entryStep === undefined) {
        throw new PocError("COMPILER_API", "the checker's loader reported no files", { entry });
      }
      const laws = path.join(path.dirname(entry), "LAWS.bend");
      const rule: EntryRule = path.basename(entry) !== "PROOF.bend"
        ? { $: "PlainEntry" }
        : { $: "ProofEntry", laws: fs.existsSync(laws) ? fs.realpathSync(laws) : null };
      return { imports: steps, entry: entryStep, rule };
    },
    async loadFills(root, namespace, steps) {
      const book = Bend.book_nil();
      const starts: number[] = [];
      try {
        await Bend.book_load(book, root, namespace, new Map(), undefined, (real, namespace, text) => {
          expectStep(steps[starts.length], real, namespace, text);
          starts.push(book.order.length);
          return false;
        });
      } catch (cause) {
        throw rejected(cause, { root });
      }
      if (starts.length !== steps.length) {
        throw unstable();
      }
      const fills: LateFill[] = [];
      const declared = new Map<string, number>();
      let step = 0;
      for (const [index, name] of book.order.entries()) {
        while (step < starts.length && (starts[step] ?? Infinity) <= index) {
          step += 1;
        }
        const first = declared.get(name);
        if (first === undefined) {
          declared.set(name, step);
        } else if (first !== step) {
          const record = book.tlds[name];
          const flags: FillFlag[] = [];
          if (record?.$ === "Def" && record.i !== undefined) {
            flags.push("FillForeign");
          }
          if (record?.$ === "Def" && record.u === true) {
            flags.push("FillUnsafe");
          }
          fills.push({ declared: first, filled: step, flags });
        }
      }
      return fills;
    },
    async check(root, namespace, groups, seed, seal) {
      let parent: BookStateLike = seed ?? { book: Bend.book_nil(), seen: new Map() };
      const seen = new Map(parent.seen);
      let last = parent.book.order.length;
      try {
        for (const group of groups) {
          const book = Main.book_over(parent.book);
          const done = book.order.length;
          const skipped: string[] = [];
          let count = 0;
          await Bend.book_load(book, root, namespace, seen, undefined, (real, loaded, text) => {
            // Files before the group are already seen. The loader reaches the
            // group's files next, in order; later files are left unparsed
            // and forgotten, so the next group loads them.
            if (count < group.steps.length) {
              expectStep(group.steps[count], real, loaded, text);
              count += 1;
              last = book.order.length;
              return false;
            }
            skipped.push(real);
            return true;
          });
          if (count !== group.steps.length) {
            throw unstable();
          }
          for (const real of skipped) {
            seen.delete(real);
          }
          Bend.book_valid(book, done);
          const child = { book, seen: new Map(seen) };
          seal(group.key, parent, child, last);
          parent = child;
        }
      } catch (cause) {
        throw rejected(cause, { root });
      }
      return { state: parent, last };
    },
    verdict(state, n0) {
      try {
        Comp.book_owned(state.book, Comp.SYNTH);
      } catch (cause) {
        throw rejected(cause, {});
      }
      return {
        todos: state.book.hols + state.book.open,
        reliant: reliant(state.book, n0),
      };
    },
    emitRestored(state, target) {
      try {
        return emit(replay(state.book), target);
      } catch (cause) {
        throw rejected(cause, { target });
      }
    },
    emit(book, target) {
      return emit(Main.book_flat(book), target);
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
        throw rejected(cause, { target: "js-library" });
      }
    },
    formatError(error) {
      return formatBendError(Bend, error);
    },
  };
  return runtime;
}

// The checker must read exactly the files the keys were computed from.
function expectStep(
  step: LoadStep | undefined,
  real: string,
  namespace: string,
  text: string,
): void {
  if (
    step === undefined ||
    step.path !== real ||
    step.namespace !== namespace ||
    step.text !== text
  ) {
    throw unstable();
  }
}

function unstable(): PocError {
  return new PocError("UNSTABLE_INPUTS", "source inputs changed during compilation");
}

// The checker's own rendering of a rejection (main.ts book_err): a kernel
// error by err_show, a stack overflow by its note, anything else (the
// compiler's Error, a thrown string) by String.
function formatBendError(Bend: BendModule, error: unknown): string {
  if (error instanceof RangeError) {
    return "Error: the machine stack overflowed (a deep recursion, or a"
      + " literal too large to expand)";
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "$" in error &&
    (error as { $?: unknown }).$ === "Err" &&
    typeof Bend.err_show === "function"
  ) {
    return Bend.err_show(error);
  }
  return String(error);
}
