// A pack's term table: every node of every stored term in the pack, once per
// distinct content, with no spans.
//
// What is stored. A checked body (`Def.e`) is a lowered term whose nodes the
// checker wraps as `Ann(x, Var("_", -1, v: T))`, T the node's type as a live
// term (closures under its binders), and whose share cells are
// `Var(k, -1, v)`. The table stores a body's nodes as data and each cell as
// (k, i, L), L the id of the cell's value lowered by the kernel at the depth
// of the binders around the cell, read off the body itself (`Lam.i`, `All.i`,
// `Let.i`, `Sub.i` are the checker's levels). A restored cell is raised
// under an environment binding each enclosing level back to its variable, so
// a free checker level stays a variable, as the checker built it, instead of
// becoming a global reference (the old F1 defect of an empty-environment
// raise). The kernel's raise returns a `Var` with a negative level unchanged,
// so the compiler reads restored cells as it reads the checker's.
//
// Why by content, and why without spans. The checker shares one type among
// many cells through closures; lowering writes it out per cell, so bodies
// written as trees are mostly copies of the same types. And a type written
// out carries the spans of wherever its pieces came from, so equal types are
// unequal data. On bend-categories' `Interchange/Braided_Unsafe.bend`: 1,020
// bodies, 11.7 M body nodes, 3.9 M cells; 26 M distinct nodes with spans,
// 485 K without. The compiler reads no span of a body or of a type (it keys
// types span-free: comp.ts `ty_key`, `term_same`), so the table has none.
//
// The law is the emitted program: `compile_book` and `js_book` over restored
// bodies equal their output over the checker's own (test/term-table.test.ts).
// Decode∘encode is the identity up to spans and up to the kernel's raise,
// which reduces a redex it builds; after one round trip the encoding is
// stable. Both directions walk with explicit work lists, never the machine
// stack: a generated proof's body can be tens of thousands of nodes deep.

// The kernel functions the table calls; it mirrors none of them.
export interface TermKernel {
  term_lower(term: unknown, depth?: number): unknown;
  term_higher(term: unknown, env?: unknown): unknown;
  Var(k: string, i: number, s?: unknown, v?: unknown): unknown;
  list_set(list: unknown, key: number, value: unknown): unknown;
}

// A stored node is a JSON value: a term node whose object children are
// `{ "@": id }` references and whose primitive children are inline (an array
// of primitives is inline too), an array of such children, or a body cell
// `{ "$": "Var", k, i, L }` with L the id of its lowered value.
export type WireNode = unknown;

type Node = Record<string, unknown>;
type Binder = readonly [string, number];

const isReference = (value: unknown): value is { readonly "@": number } =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.keys(value).length === 1 && typeof (value as { "@"?: unknown })["@"] === "number";

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

// A body cell: a share or annotation cell whose value is a live term.
const isCell = (node: Node): boolean => node.$ === "Var" && isObject(node.v);

const isPrimitive = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

// The field of a binding node that sits under its binders, and the levels it
// binds. `read` resolves a child that may be a stored reference.
const BODY_FIELD: Readonly<Record<string, string>> = { Lam: "f", All: "B", Let: "f", Sub: "f" };

function patternLevels(pattern: unknown, read: (value: unknown) => unknown, out: number[]): void {
  for (const todo = [pattern]; todo.length > 0;) {
    const item = read(todo.pop());
    if (Array.isArray(item)) {
      todo.push(...item);
    } else if (isObject(item)) {
      const node = item as Node;
      if (node.$ === "PVar" && typeof node.i === "number") {
        out.push(node.i);
      } else if (node.$ === "PCtr") {
        todo.push(node.x);
      }
    }
  }
}

function binders(node: Node, read: (value: unknown) => unknown): Binder[] {
  switch (node.$) {
    case "Lam":
    case "All":
      return [[String(node.k), Number(node.i)]];
    case "Let":
      return (read(node.k) as string[]).map((k, j) => [k, (read(node.i) as number[])[j] as number] as const);
    case "Sub": {
      const levels: number[] = [];
      patternLevels(node.v, read, levels);
      return [["_", Number(node.i)], ...levels.map((i) => ["_", i] as const)];
    }
    default:
      return [];
  }
}

// The depth under a binding node: one past the deepest level it binds.
const depthUnder = (node: Node, depth: number): number =>
  Math.max(depth, ...binders(node, (value) => value).map(([, i]) => i + 1));

export class TermTable {
  readonly nodes: WireNode[] = [];
  private readonly index = new Map<string, number>();
  // A cell's value lowered at a depth, once: the checker shares values among
  // cells (one module: 3.9 M cells, 2.0 M values).
  private readonly lowered = new WeakMap<object, Map<number, number>>();
  // A cell inside a lowered term, by identity: the kernel shares them.
  private readonly cells = new WeakMap<object, number>();

  constructor(private readonly kernel: TermKernel) {}

  // The root id of a checked body.
  body(term: object): number {
    return this.add(term, 0, true);
  }

  // A node by its wire text.
  private intern(text: string): number {
    let id = this.index.get(text);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push(JSON.parse(text) as WireNode);
      this.index.set(text, id);
    }
    return id;
  }

  private cellValue(value: object, depth: number): number {
    let byDepth = this.lowered.get(value);
    if (byDepth === undefined) {
      byDepth = new Map();
      this.lowered.set(value, byDepth);
    }
    let id = byDepth.get(depth);
    if (id === undefined) {
      const low = this.kernel.term_lower(value, depth);
      if (!isObject(low)) {
        throw new Error("a cell's value lowered to a non-term");
      }
      id = this.add(low, 0, false);
      byDepth.set(depth, id);
    }
    return id;
  }

  // Adds a term's distinct nodes, children first, and returns its root id.
  // In a body, a cell is stored as (k, i, L) with its value lowered at the
  // cell's depth; in a lowered term, a cell is data (the kernel keeps its
  // share cells first-order), so a closure anywhere is an error. A node's
  // key is its own wire text, so the table is canonical by construction.
  //
  // A term is a tree (the checker's bodies share no nodes; a lowered term is
  // fresh but for the leaves and cells the kernel returns as they are), so
  // the walk is a post-order over frames with one shared result stack: a
  // child's id is pushed when it is done, and a parent takes its children's
  // ids from the stack above its mark. Cells of a lowered term are shared
  // among many terms and are remembered by identity.
  private add(root: object, depth: number, body: boolean): number {
    const results: number[] = [];
    const frames: Array<{ readonly value: object; readonly depth: number; readonly keys: readonly string[] | null; next: number; readonly mark: number }> = [];
    const closure = (): never => {
      throw new Error(body ? "a checked body holds a closure outside a cell" : "a lowered term holds a closure");
    };
    const inline = (value: unknown): boolean =>
      !isObject(value) || (Array.isArray(value) && value.every(isPrimitive));
    // Visits a child: inline values need nothing; a known cell contributes
    // its id; anything else gets a frame.
    const visit = (value: unknown, at: number): void => {
      if (typeof value === "function") {
        closure();
      }
      if (inline(value)) {
        return;
      }
      const node = value as object;
      if (!Array.isArray(node)) {
        const record = node as Node;
        if (isCell(record)) {
          if (body) {
            results.push(this.intern(JSON.stringify({ $: "Var", k: record.k, i: record.i, L: this.cellValue(record.v as object, at) })));
            return;
          }
          const known = this.cells.get(node);
          if (known !== undefined) {
            results.push(known);
            return;
          }
        }
      }
      frames.push({ value: node, depth: at, keys: Array.isArray(node) ? null : Object.keys(node), next: 0, mark: results.length });
    };
    visit(root, depth);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as (typeof frames)[number];
      const value = frame.value;
      if (Array.isArray(value)) {
        if (frame.next < value.length) {
          visit(value[frame.next++], frame.depth);
          continue;
        }
      } else {
        const node = value as Node;
        const keys = frame.keys as readonly string[];
        if (frame.next < keys.length) {
          const field = keys[frame.next++] as string;
          if (field !== "s") {
            const under = BODY_FIELD[String(node.$)];
            visit(node[field], field === under ? depthUnder(node, frame.depth) : frame.depth);
          }
          continue;
        }
      }
      frames.pop();
      // Children's ids, in field order, above the mark.
      let taken = frame.mark;
      const child = (item: unknown): unknown => inline(item) ? (Array.isArray(item) ? [...item] : item) : { "@": results[taken++] };
      let out: WireNode;
      if (Array.isArray(value)) {
        out = value.map(child);
      } else {
        const node = value as Node;
        const record: Node = {};
        for (const field of frame.keys as readonly string[]) {
          const item = node[field];
          if (field !== "s" && item !== undefined) {
            record[field] = child(item);
          }
        }
        out = record;
      }
      results.length = frame.mark;
      const id = this.intern(JSON.stringify(out));
      if (!body && !Array.isArray(value) && isCell(value as Node)) {
        this.cells.set(value, id);
      }
      results.push(id);
    }
    return results[0] as number;
  }
}

// The binders around a node, innermost first, shared between siblings; `key`
// names the chain, so equal chains share restored nodes and raised values.
interface Scope {
  readonly k: string;
  readonly i: number;
  readonly depth: number;
  readonly key: string;
  readonly up: Scope | null;
  env?: unknown;
}

const scopeKey = (scope: Scope | null): string => scope?.key ?? "";

// The decoded side of a table: `nodes` has been through the pack's restore
// (interned names).
export class StoredTerms {
  // Each id's lowered term, built once and shared: a lowered term is closed
  // data, read the same from anywhere.
  private readonly terms: unknown[];

  constructor(private readonly kernel: TermKernel, private readonly nodes: readonly WireNode[]) {
    this.terms = new Array(nodes.length);
  }

  private node(id: number): WireNode {
    const raw = this.nodes[id];
    if (raw === undefined) {
      throw new Error(`a stored term refers to node ${id}, which the pack does not hold`);
    }
    return raw;
  }

  // A lowered term by id.
  term(id: number): unknown {
    const read = (value: unknown): unknown => isReference(value) ? this.terms[value["@"]] : value;
    for (const todo = [id]; todo.length > 0;) {
      const at = todo[todo.length - 1] as number;
      if (this.terms[at] !== undefined) {
        todo.pop();
        continue;
      }
      const raw = this.node(at);
      const items = Array.isArray(raw) ? raw : Object.values(raw as Node);
      const missing = items.filter((item) => isReference(item) && this.terms[item["@"]] === undefined)
        .map((item) => (item as { "@": number })["@"]);
      if (missing.length > 0) {
        todo.push(...missing);
        continue;
      }
      todo.pop();
      if (Array.isArray(raw)) {
        this.terms[at] = raw.map(read);
      } else {
        const out: Node = {};
        for (const [field, item] of Object.entries(raw as Node)) {
          out[field] = read(item);
        }
        this.terms[at] = out;
      }
    }
    return this.terms[id];
  }

  // A checked body by root id, as the compiler reads it. A node is built
  // once per binder chain it sits under, since its cells are raised under
  // that chain; a cell's value is raised once per (value, chain).
  body(root: number): unknown {
    const made = new Map<string, Map<number, object>>();
    const raised = new Map<string, Map<number, unknown>>();
    const work: Array<{ readonly id: number; readonly scope: Scope | null; readonly out: object }> = [];
    const resolve = (value: unknown): unknown => isReference(value) ? this.node(value["@"]) : value;
    const envOf = (scope: Scope | null): unknown => {
      if (scope === null) {
        return null;
      }
      if (scope.env === undefined) {
        let env: unknown = null;
        const seen = new Set<number>();
        for (let at: Scope | null = scope; at !== null; at = at.up) {
          if (!seen.has(at.i)) {
            seen.add(at.i);
            env = this.kernel.list_set(env, at.i, this.kernel.Var(at.k, at.i));
          }
        }
        scope.env = env;
      }
      return scope.env;
    };
    const raise = (L: number, scope: Scope | null): unknown => {
      const key = scopeKey(scope);
      let byValue = raised.get(key);
      if (byValue === undefined) {
        byValue = new Map();
        raised.set(key, byValue);
      }
      let value = byValue.get(L);
      if (value === undefined) {
        value = this.kernel.term_higher(this.term(L), envOf(scope));
        byValue.set(L, value);
      }
      return value;
    };
    const get = (value: unknown, scope: Scope | null): unknown => {
      if (!isReference(value)) {
        return Array.isArray(value) ? [...value] : value;
      }
      const id = value["@"];
      const key = scopeKey(scope);
      let byId = made.get(key);
      if (byId === undefined) {
        byId = new Map();
        made.set(key, byId);
      }
      const known = byId.get(id);
      if (known !== undefined) {
        return known;
      }
      const raw = this.node(id);
      let out: object;
      if (Array.isArray(raw)) {
        out = [];
      } else {
        const node = raw as Node;
        if (node.$ === "Var" && typeof node.L === "number") {
          out = this.kernel.Var(String(node.k), Number(node.i), undefined, raise(node.L, scope)) as object;
          byId.set(id, out);
          return out;
        }
        out = {};
      }
      byId.set(id, out);
      work.push({ id, scope, out });
      return out;
    };
    const extend = (node: Node, scope: Scope | null): Scope | null => {
      for (const [k, i] of binders(node, resolve)) {
        scope = { k, i, depth: Math.max(scope?.depth ?? 0, i + 1), key: `${scopeKey(scope)},${k}:${i}`, up: scope };
      }
      return scope;
    };
    const result = get({ "@": root }, null);
    for (let task = work.pop(); task !== undefined; task = work.pop()) {
      const raw = this.node(task.id);
      if (Array.isArray(raw)) {
        const out = task.out as unknown[];
        for (const item of raw) {
          out.push(get(item, task.scope));
        }
        continue;
      }
      const node = raw as Node;
      const under = BODY_FIELD[String(node.$)];
      const inner = under === undefined ? task.scope : extend(node, task.scope);
      const out = task.out as Node;
      // Fields keep their stored order.
      for (const field in node) {
        out[field] = get(node[field], field === under ? inner : task.scope);
      }
    }
    return result;
  }
}
