// Checked bodies (`Def.e`) as stored data, so a restored state compiles
// without re-elaborating anything.
//
// A checked body is a lowered term (an LTerm) whose nodes the checker wraps
// as `Ann(x, Var("_", -1, v: T))`, and whose share cells are `Var(k, -1, v)`.
// Every closure in a body lives under such a cell's `v`, a raised term; the
// rest is data. The kernel's raise returns a `Var` with a negative level
// unchanged, so the compiler reads those cells as they are.
//
// So a body is stored as a DAG of its own nodes (shared nodes once), with
// each cell's value lowered by the kernel at the depth of the binders around
// the cell, and restored by raising that value under an environment that
// binds each enclosing level back to its variable. A free checker level then
// stays a variable, as the checker built it, instead of becoming a global
// reference (the old F1 defect of an empty-environment raise).
//
// The law is that the emitted program is the same: `compile_book` and
// `js_book` over restored bodies equal their output over the checker's own
// (test/body-codec.test.ts). Spans are left as span objects; the pack's one
// stringify pass writes them through its source table.

// The kernel functions the codec calls; it mirrors none of them.
export interface BodyKernel {
  term_lower(term: unknown, depth?: number): unknown;
  term_higher(term: unknown, env?: unknown): unknown;
  Var(k: string, i: number, s?: unknown, v?: unknown): unknown;
  list_set(list: unknown, key: number, value: unknown): unknown;
}

// A stored body: its nodes, each a JSON value whose object children are
// `{ "@": id }` references, and the root's id. A cell's lowered value is
// field `L`.
export interface WireBody {
  readonly n: readonly unknown[];
  readonly r: number;
}

type Node = Record<string, unknown>;
type Binder = readonly [string, number];

// The fields of a binding node that sit under its binders, and the levels it
// binds. Levels are the checker's, read off the node itself.
const BODY_FIELD: Readonly<Record<string, string>> = { Lam: "f", All: "B", Let: "f", Sub: "f" };

function patternLevels(p: unknown): number[] {
  const node = p as Node | null;
  if (node?.$ === "PVar" && typeof node.i === "number") {
    return [node.i];
  }
  return node?.$ === "PCtr" && Array.isArray(node.x) ? node.x.flatMap(patternLevels) : [];
}

function binds(node: Node): Binder[] {
  switch (node.$) {
    case "Lam":
    case "All":
      return [[String(node.k), Number(node.i)]];
    case "Let":
      return (node.k as string[]).map((k, j) => [k, (node.i as number[])[j] as number] as const);
    case "Sub":
      return [["_", Number(node.i)], ...patternLevels(node.v).map((i) => ["_", i] as const)];
    default:
      return [];
  }
}

// The depth under a binding node: one past the deepest level it binds.
function depthUnder(node: Node, depth: number): number {
  return Math.max(depth, ...binds(node).map(([, i]) => i + 1));
}

const isPrimitive = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean", "undefined"].includes(typeof value);

const isReference = (value: unknown): value is { readonly "@": number } =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.keys(value).length === 1 && typeof (value as { "@"?: unknown })["@"] === "number";

export function encodeBody(kernel: BodyKernel, body: unknown): WireBody {
  const ids = new Map<object, number>();
  const nodes: unknown[] = [];
  const leaves = new Map<string, number>();
  const files = new Map<object, number>();
  const spanKey = (span: unknown): string => {
    const s = span as { file?: object; beg?: number; end?: number } | undefined;
    if (s?.file === undefined) {
      return "";
    }
    let file = files.get(s.file);
    if (file === undefined) {
      file = files.size;
      files.set(s.file, file);
    }
    return `${file}:${s.beg}:${s.end}`;
  };
  const leafKey = (node: Node): string | undefined => {
    const parts: string[] = [];
    for (const field in node) {
      const value = node[field];
      if (field === "s") {
        parts.push(`s=${spanKey(value)}`);
      } else if (isPrimitive(value)) {
        parts.push(`${field}=${JSON.stringify(value) ?? "u"}`);
      } else {
        return undefined;
      }
    }
    return parts.join("\u0000");
  };
  // A cell's value is often shared by many cells at one depth.
  const lowered = new Map<object, Map<number, unknown>>();
  const lower = (value: object, depth: number): unknown => {
    let byDepth = lowered.get(value);
    if (byDepth === undefined) {
      byDepth = new Map();
      lowered.set(value, byDepth);
    }
    let low = byDepth.get(depth);
    if (low === undefined) {
      low = kernel.term_lower(value, depth);
      byDepth.set(depth, low);
    }
    return low;
  };
  const go = (value: unknown, depth: number): unknown => {
    if (typeof value === "function") {
      throw new Error("a checked body holds a closure outside a share or annotation cell");
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }
    if (Array.isArray(value) && value.every(isPrimitive)) {
      return [...value];
    }
    const known = ids.get(value);
    if (known !== undefined) {
      return { "@": known };
    }
    // A leaf (a node whose fields are all primitives, its span aside) keeps
    // its object identity through the kernel's lowering and gets a fresh one
    // from its raise, so leaves are shared by content: the encoding of a
    // restored body is then the encoding of the checked one.
    const leaf = Array.isArray(value) ? undefined : leafKey(value as Node);
    if (leaf !== undefined) {
      const same = leaves.get(leaf);
      if (same !== undefined) {
        ids.set(value, same);
        return { "@": same };
      }
    }
    const id = nodes.length;
    if (leaf !== undefined) {
      leaves.set(leaf, id);
    }
    ids.set(value, id);
    nodes.push(null);
    if (Array.isArray(value)) {
      nodes[id] = value.map((item) => go(item, depth));
      return { "@": id };
    }
    const node = value as Node;
    if (node.$ === "Var" && typeof node.v === "object" && node.v !== null) {
      nodes[id] = { $: "Var", k: node.k, i: node.i, s: node.s, L: go(lower(node.v, depth), depth) };
      return { "@": id };
    }
    const under = BODY_FIELD[String(node.$)];
    const inner = under === undefined ? depth : depthUnder(node, depth);
    const out: Node = {};
    for (const field in node) {
      // A span is written by the pack's source table, not as a node.
      out[field] = field === "s" ? node[field] : go(node[field], field === under ? inner : depth);
    }
    nodes[id] = out;
    return { "@": id };
  };
  const root = go(body, 0);
  if (!isReference(root)) {
    throw new Error("a checked body is not a term");
  }
  return { n: nodes, r: root["@"] };
}

// `wire` has been through the pack's restore (spans and interned names).
export function decodeBody(kernel: BodyKernel, wire: WireBody): unknown {
  const made: unknown[] = new Array(wire.n.length);
  // Cells that shared one value in the checker share one raised value here,
  // so encoding a restored body writes the same DAG (decode∘encode = id).
  const raised = new Map<string, unknown>();
  const go = (value: unknown, binders: readonly Binder[]): unknown => {
    if (Array.isArray(value)) {
      return [...value];
    }
    if (!isReference(value)) {
      return value;
    }
    const id = value["@"];
    if (made[id] !== undefined) {
      return made[id];
    }
    const node = wire.n[id];
    if (node === undefined) {
      throw new Error(`a stored body refers to node ${id}, which it does not hold`);
    }
    if (Array.isArray(node)) {
      const array: unknown[] = [];
      made[id] = array;
      for (const item of node) {
        array.push(go(item, binders));
      }
      return array;
    }
    const raw = node as Node;
    if (raw.$ === "Var" && "L" in raw) {
      const cell = kernel.Var(String(raw.k), Number(raw.i), raw.s, undefined) as Node;
      made[id] = cell;
      // One checker value lowers to one stored node per depth; its free levels
      // are bound by the same binders wherever it is shared.
      const depth = Math.max(0, ...binders.map(([, i]) => i + 1));
      const key = isReference(raw.L) ? `${raw.L["@"]}@${depth}` : undefined;
      const known = key === undefined ? undefined : raised.get(key);
      if (known !== undefined) {
        cell.v = known;
        return cell;
      }
      let env: unknown = null;
      for (const [k, i] of binders) {
        env = kernel.list_set(env, i, kernel.Var(k, i));
      }
      cell.v = kernel.term_higher(go(raw.L, binders), env);
      if (key !== undefined) {
        raised.set(key, cell.v);
      }
      return cell;
    }
    const out: Node = {};
    made[id] = out;
    const under = BODY_FIELD[String(raw.$)];
    // Fields keep their stored order; the binding field is filled last,
    // once the binders it sits under are known.
    for (const field in raw) {
      out[field] = undefined;
    }
    for (const field in raw) {
      if (field !== under) {
        out[field] = go(raw[field], binders);
      }
    }
    if (under !== undefined && under in raw) {
      out[under] = go(raw[under], [...binders, ...binds(out)]);
    }
    return out;
  };
  return go({ "@": wire.r }, []);
}
