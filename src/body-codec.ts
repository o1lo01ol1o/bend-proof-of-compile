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

// Both directions walk with explicit work lists, never the machine stack: a
// generated proof's body can be tens of thousands of nodes deep.

// `limit` bounds the stored nodes; a body that would exceed it is not
// encoded (undefined), and compilation re-elaborates it instead.
export function encodeBody(kernel: BodyKernel, body: unknown): WireBody;
export function encodeBody(kernel: BodyKernel, body: unknown, limit: number): WireBody | undefined;
export function encodeBody(kernel: BodyKernel, body: unknown, limit = Infinity): WireBody | undefined {
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
  // A leaf (a node whose fields are all primitives, its span aside) keeps
  // its object identity through the kernel's lowering and gets a fresh one
  // from its raise, so leaves are shared by content: the encoding of a
  // restored body is then the encoding of the checked one.
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
  const work: Array<{ readonly value: object; readonly depth: number; readonly id: number }> = [];
  // The wire form of a child: inline when primitive, else a reference to its
  // node, whose fields are filled when its turn on the work list comes.
  const ref = (value: unknown, depth: number): unknown => {
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
    const leaf = Array.isArray(value) ? undefined : leafKey(value as Node);
    if (leaf !== undefined) {
      const same = leaves.get(leaf);
      if (same !== undefined) {
        ids.set(value, same);
        return { "@": same };
      }
    }
    const id = nodes.length;
    if (id >= limit) {
      throw OVER_LIMIT;
    }
    ids.set(value, id);
    nodes.push(null);
    if (leaf !== undefined) {
      leaves.set(leaf, id);
    }
    work.push({ value, depth, id });
    return { "@": id };
  };
  try {
    const root = ref(body, 0);
    if (!isReference(root)) {
      throw new Error("a checked body is not a term");
    }
    fill();
    return { n: nodes, r: root["@"] };
  } catch (error) {
    if (error === OVER_LIMIT) {
      return undefined;
    }
    throw error;
  }
  function fill(): void {
  for (let task = work.pop(); task !== undefined; task = work.pop()) {
    const { value, depth, id } = task;
    if (Array.isArray(value)) {
      nodes[id] = value.map((item) => ref(item, depth));
      continue;
    }
    const node = value as Node;
    if (node.$ === "Var" && typeof node.v === "object" && node.v !== null) {
      nodes[id] = { $: "Var", k: node.k, i: node.i, s: node.s, L: ref(lower(node.v, depth), depth) };
      continue;
    }
    const under = BODY_FIELD[String(node.$)];
    const inner = under === undefined ? depth : depthUnder(node, depth);
    const out: Node = {};
    for (const field in node) {
      // A span is written by the pack's source table, not as a node.
      out[field] = field === "s" ? node[field] : ref(node[field], field === under ? inner : depth);
    }
    nodes[id] = out;
  }
  }
}

const OVER_LIMIT = Symbol("the body exceeds its node limit");

// The binders around a node, innermost first, shared between siblings.
type Scope = { readonly k: string; readonly i: number; readonly depth: number; readonly up: Scope } | null;

const scopeDepth = (scope: Scope): number => scope?.depth ?? 0;

// `wire` has been through the pack's restore (spans and interned names).
export function decodeBody(kernel: BodyKernel, wire: WireBody): unknown {
  const made: unknown[] = new Array(wire.n.length);
  // Cells that shared one value in the checker share one raised value here.
  const raised = new Map<string, unknown>();
  const cells: Array<{ readonly cell: Node; readonly low: unknown; readonly key: string | undefined; readonly scope: Scope }> = [];
  const work: Array<{ readonly id: number; readonly scope: Scope }> = [];
  const node = (id: number): unknown => {
    const raw = wire.n[id];
    if (raw === undefined) {
      throw new Error(`a stored body refers to node ${id}, which it does not hold`);
    }
    return raw;
  };
  const get = (value: unknown, scope: Scope): unknown => {
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
    const raw = node(id);
    const shell = Array.isArray(raw) ? [] : (raw as Node).$ === "Var" && "L" in (raw as Node)
      ? kernel.Var(String((raw as Node).k), Number((raw as Node).i), (raw as Node).s, undefined)
      : {};
    made[id] = shell;
    work.push({ id, scope });
    return shell;
  };
  // A pattern's levels, read off the wire (its nodes may not be built yet).
  const wireLevels = (value: unknown): number[] => {
    const levels: number[] = [];
    for (const todo = [value]; todo.length > 0;) {
      const item = todo.pop();
      const raw = (isReference(item) ? node(item["@"]) : item) as Node | unknown[] | null;
      if (Array.isArray(raw)) {
        todo.push(...raw);
      } else if (raw?.$ === "PVar" && typeof raw.i === "number") {
        levels.push(raw.i);
      } else if (raw?.$ === "PCtr") {
        todo.push(raw.x);
      }
    }
    return levels;
  };
  const extend = (raw: Node, scope: Scope): Scope => {
    let binders: Binder[];
    switch (raw.$) {
      case "Lam":
      case "All":
        binders = [[String(raw.k), Number(raw.i)]];
        break;
      case "Let":
        binders = (raw.k as string[]).map((k, j) => [k, (raw.i as number[])[j] as number] as const);
        break;
      case "Sub":
        binders = [["_", Number(raw.i)], ...wireLevels(raw.v).map((i) => ["_", i] as const)];
        break;
      default:
        binders = [];
    }
    for (const [k, i] of binders) {
      scope = { k, i, depth: Math.max(scopeDepth(scope), i + 1), up: scope };
    }
    return scope;
  };
  const root = get({ "@": wire.r }, null);
  for (let task = work.pop(); task !== undefined; task = work.pop()) {
    const { id, scope } = task;
    const raw = node(id);
    const out = made[id] as Node & unknown[];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        out.push(get(item, scope));
      }
      continue;
    }
    const fields = raw as Node;
    if (fields.$ === "Var" && "L" in fields) {
      const key = isReference(fields.L) ? `${fields.L["@"]}@${scopeDepth(scope)}` : undefined;
      cells.push({ cell: out, low: get(fields.L, scope), key, scope });
      continue;
    }
    const under = BODY_FIELD[String(fields.$)];
    // Fields keep their stored order.
    for (const field in fields) {
      out[field] = field === under
        ? get(fields[field], extend(fields, scope))
        : field === "s" ? fields[field] : get(fields[field], scope);
    }
  }
  // Raise each cell's value once every stored node is built: a free level i
  // becomes the variable its enclosing binder makes.
  for (const { cell, low, key, scope } of cells) {
    const known = key === undefined ? undefined : raised.get(key);
    if (known !== undefined) {
      cell.v = known;
      continue;
    }
    let env: unknown = null;
    const seen = new Set<number>();
    for (let at = scope; at !== null; at = at.up) {
      if (!seen.has(at.i)) {
        seen.add(at.i);
        env = kernel.list_set(env, at.i, kernel.Var(at.k, at.i));
      }
    }
    cell.v = kernel.term_higher(low, env);
    if (key !== undefined) {
      raised.set(key, cell.v);
    }
  }
  return root;
}
