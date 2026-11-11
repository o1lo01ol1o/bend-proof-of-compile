import * as fs from "node:fs";
import * as path from "node:path";

import { summaryOf, type RecordSummary } from "./codec.ts";
import type { BookLike, CompilerRuntime, LoadStep } from "./compiler.ts";
import { PocError } from "./error.ts";

// `poc unreached`: the definitions in the .bend files under a directory that
// the given defs of a checked state (one, or a comma-separated list: a
// program's roots) do not reach, and the files there its load order never
// loads.
//
// The reach follows each record's stored references (the names its type and
// elaboration refer to, as the checker's report reads them), so it sees what
// elaboration resolved and raises no record. A call to a template instance
// k~n reaches the instance and its template k.
//
// Laws: nothing calls a law, so a law is kept when it names a reached
// definition (outside Base, not a law); what a kept law reaches is kept
// with it, and reported apart, as reached only by laws. A law about
// unreached code is unreached with it.
export function unreachedReport(
  runtime: CompilerRuntime,
  book: BookLike,
  steps: readonly LoadStep[],
  start: string,
  dir: string,
): string {
  const entry = steps[steps.length - 1];
  if (entry === undefined) {
    throw new PocError("COMPILER_API", "the load order has no entry");
  }
  const root = realDirectory(dir);
  const summary = (name: string): RecordSummary | undefined => summaryOf(runtime, book.tlds, name);
  const template = (name: string): string => name.includes("~") ? name.slice(0, name.indexOf("~")) : name;
  const refs = (name: string): readonly string[] =>
    summary(name)?.refs ?? (template(name) === name ? [] : summary(template(name))?.refs ?? []);
  const base = (name: string): boolean => summary(template(name))?.base !== false;
  const law = (name: string): boolean => summary(name)?.law === true;

  const starts = start.split(",").map((name) => name.trim());
  const keys = starts.map((name) => {
    const key = name === "" ? undefined : keyOf(book, entry.namespace, name);
    if (key === undefined) {
      throw new PocError("CLI_USAGE", `no definition ${name} in ${shown(entry.path)}`);
    }
    return key;
  });

  // Each name's file, by its namespace (a bare name is in a file loaded
  // under "": Base's are Base records, the rest the entry's).
  const files = new Map<string, string>();
  for (const step of steps) {
    files.set(step.namespace, step.path);
  }
  const fileOf = (name: string): string | undefined => {
    const colon = name.indexOf(":");
    return files.get(colon < 0 ? "" : name.slice(0, colon));
  };

  const closure = (seeds: readonly string[], into: Set<string>, skip: ReadonlySet<string>): string[] => {
    const added: string[] = [];
    const todo = [...seeds];
    for (let name; (name = todo.pop()) !== undefined;) {
      if (into.has(name) || skip.has(name)) {
        continue;
      }
      into.add(name);
      added.push(name);
      todo.push(template(name), ...refs(name));
    }
    return added;
  };

  const reached = new Set<string>();
  closure(keys, reached, new Set());

  // Laws kept by the reached code, to a fixpoint.
  const own = [...new Set(book.order)].filter((name) => !base(name));
  const kept = new Set<string>();
  const keptBy = new Map<string, string[]>();
  for (let grew = true; grew;) {
    grew = false;
    for (const name of own) {
      if (!law(name) || reached.has(name) || kept.has(name)) {
        continue;
      }
      const about = refs(name).some((ref) => !base(ref) && !law(template(ref))
        && (reached.has(ref) || kept.has(ref)));
      if (about) {
        for (const added of closure([name], kept, reached)) {
          if (added !== name) {
            (keptBy.get(added) ?? keptBy.set(added, []).get(added) as string[]).push(name);
          }
        }
        grew = true;
      }
    }
  }

  const under = bendFilesUnder(root);
  const label = (name: string): string => {
    const record = book.tlds[name];
    const kind = record?.$ === "ADT" ? "type" : law(name) ? "law" : "def";
    return kind + " " + spelled(name);
  };
  const byFile = (names: readonly string[], note: (name: string) => string): string[] => {
    const grouped = new Map<string, string[]>();
    for (const name of names) {
      const file = fileOf(name) as string;
      (grouped.get(file) ?? grouped.set(file, []).get(file) as string[]).push("  " + label(name) + note(name));
    }
    return [...grouped.keys()].sort().flatMap((file) => [shown(file), ...(grouped.get(file) as string[])]);
  };

  const defined = own.filter((name) => {
    const file = fileOf(name);
    return file !== undefined && under.has(file);
  });
  const unreached = defined.filter((name) => !reached.has(name) && !kept.has(name));
  const lawOnly = defined.filter((name) => kept.has(name) && !law(name));
  const loaded = new Set(steps.map((step) => step.path));
  const unloaded = [...under].filter((file) => !loaded.has(file)).sort();

  const lines = [
    `unreached from ${starts.join(", ")}: ${unreached.length} of ${defined.length} definitions under ${shown(root)}`,
    ...byFile(unreached, () => ""),
  ];
  if (unloaded.length > 0) {
    lines.push(`not loaded by ${shown(entry.path)}:`, ...unloaded.map((file) => "  " + shown(file)));
  }
  if (lawOnly.length > 0) {
    lines.push("reached only by laws about reached code:", ...byFile(lawOnly, (name) =>
      " (kept by " + (keptBy.get(name) ?? []).map((by) => "law " + spelled(by)).join(", ") + ")"));
  }
  return lines.join("\n");
}

// The key of a def as the root file spells it: its own names are bare in
// the entry, `Namespace:Name` in a module; a dotted key (as reports print
// it) is accepted too.
function keyOf(book: BookLike, namespace: string, start: string): string | undefined {
  const candidates = [
    namespace === "" ? start : namespace + ":" + start,
    start,
    start.replace(".", ":"),
  ];
  return candidates.find((name) => book.tlds[name] !== undefined && book.order.includes(name));
}

// A name as its own file spells it.
function spelled(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function realDirectory(dir: string): string {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch (cause) {
    throw new PocError("CLI_USAGE", `not a directory: ${dir}`, {}, { cause });
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new PocError("CLI_USAGE", `not a directory: ${dir}`);
  }
  return real;
}

// The real paths of the .bend files under root: hidden directories are
// skipped, and a symbolic link is followed only when it resolves under root.
function bendFilesUnder(root: string): Set<string> {
  const out = new Set<string>();
  const visited = new Set<string>();
  const inside = (real: string): boolean => real === root || real.startsWith(root + path.sep);
  const walk = (directory: string): void => {
    if (visited.has(directory)) {
      return;
    }
    visited.add(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      let real: string;
      try {
        real = fs.realpathSync(path.join(directory, entry.name));
      } catch {
        continue;
      }
      if (!inside(real)) {
        continue;
      }
      const stat = fs.statSync(real);
      if (stat.isDirectory()) {
        walk(real);
      } else if (stat.isFile() && real.endsWith(".bend")) {
        out.add(real);
      }
    }
  };
  walk(root);
  return out;
}

// A path as the report prints it: relative to the working directory when
// inside it ("." for the directory itself), else as given.
function shown(file: string): string {
  const relative = path.relative(process.cwd(), file);
  if (relative === "") {
    return ".";
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}
