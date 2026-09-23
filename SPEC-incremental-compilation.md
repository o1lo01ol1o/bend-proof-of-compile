# Spec: correct incremental compilation

## Purpose

`bend-proof-of-compile` reuses checked compiler states across builds. The MVP (`deb3297`) works end to end, but some of its reused states are not states a cold compile reaches, some of its restored artifacts can differ from cold ones, and most of its cost is overhead rather than checking. This spec defines the changes that make every incremental result identical to a cold build, built on a checker capability now added to the Bend fork.

The architectural rule in `HANDOFF.md` stands: **all semantics live in Bend; TypeScript is only a capability host.** The Bend checker is a capability like any other, so what it reports (its load order, its checked records) is data the Bend application folds into keys; the host still never computes a key or decides invalidation.

## What the fork provides

Branch `expose-book-state-api` of `o1lo01ol1o/bend`, on top of `163230d1` (PR #1's `book_read(file, unsafe_seed)`):

| Commit | Change |
|---|---|
| `a583f801` | Reporting and compiling a value shared by lets is linear, not exponential (report walk, `type_adts`, `facts_hot`, hash-consed layout keys `Bend.term_id`); `Bend.term_lower(t, d, low)` takes an optional (node, depth) cache that lowers shared values once |
| `625b8460` | Public regressions in `tests/snapshot/`: law fills seen at declarations, instances and dead uses across a fill, nested templates, the open-work count |
| `f0568d4f` | Immutable parents: a law's fill copies its record; `book_valid(book, done)` resumes over a parent's tables without re-installing any prefix record; `Main.book_over(parent)` makes a child book whose tables extend the parent's; `Main.book_flat(book)`; `--checkup` builds on Base only when `import Base` is a test's first import |
| `15b83be6` | `book_read`'s `PROOF.bend` rule throws instead of exiting the process |
| `2a73ce8b` | The loader reports its steps: `book_load(…, on)` and `book_read(…, on)` |
| `8d230339` | `book_valid` re-registers the constructors of a flat seed's datatypes (the MVP's `cloneCheckedBook` keeps working until milestone 3 replaces it with `book_over`) |
| `6e37fa9f` | `book_read` returns a seeded book flat, so a caller that enumerates its tables (the MVP's codec) sees every name |
| `80ffd6d1` | A child book counts its parent's holes and open laws: `book_over` copies the parent's `hols` and `open`, and `book_valid` takes back the parent's count for an open law the child's events touch, so a resumed check's TODO verdict is the cold one |

### Kernel API, as the host uses it

```ts
// The loader's steps. `on` sees each newly loaded file in load order
// (after its imports, before its own parse). Returning true skips the parse,
// so a walk with () => true resolves the whole import graph without parsing.
Bend.book_load(book, file, ns, seen, spn?, on?: (real: string, ns: string, text: string) => boolean | void): Promise<number>

// A child book over a checked parent. The parent is never written:
// a fill copies its law, and book_valid(child, done) reveals only the child's events.
// The child's hols and open start at the parent's, so child.hols + child.open
// is the cold TODO count of everything loaded so far.
Main.book_over(parent: Book): Book
Bend.book_valid(child, done)            // done = child.order.length before loading
Main.book_flat(book: Book): Book        // flatten a child before emitting (the emitters read own properties)

// PR #1's entry point: a seeded file checks in a book_over child, and the
// result comes back flat (its tables own every name).
Main.book_read(file, unsafe_seed?, on?)

// Keys and lowering
Bend.term_lower(t, d = 0, low?: Map)    // with low: shared values lower once (a DAG)
Bend.term_id(t)                          // equal ids exactly when term_key(term_lower(t)) is equal
```

Measured on the fork (pinned build `163230d1` as the oracle):
- Every public input's `--check-only` output, every `--checkup` section and every runnable test's C, JS and CLI output are byte-identical to cold.
- 1,121 Base-first tests checked as children of one Base parent with frozen records: zero parent writes, zero re-installed parent names; the C and JS of 635 of them equal the cold compile byte for byte.
- Sibling children filling one open parent law as `Nat` and as `Bool` match cold.
- Children of a parent with an open law and of a parent with a hole reach their cold TODO counts, whether they fill the law, leave it open or leave the hole.
- The MVP (`deb3297`) builds and passes its install check on `80ffd6d1`.
- On the private workload (41 files, 1213 events), a traversal-only walk reports all 41 steps in the checker's order with its namespaces, parses nothing, and takes 6 ms against 94 s for load and check.

## Defects in the MVP

| # | Defect | Where | Consequence |
|---|---|---|---|
| F1 | Restored elaborations are raised with an empty environment | `src/codec.ts:77`, `243–244` store `e` as `term_lower(term_higher(e))`; the compiler raises it with `term_higher` (`comp.ts` `def_body`) | Annotation types hold checker variables `Var(k, i ≥ 0)`, which an empty-environment raise turns into global references. A round-2 probe (a recursive polymorphic definition at `List<&2, U32>`) produced different C and a binary that faulted. Lowering `e` without a cache is also exponential on let chains (24 lets: over 30 GB). |
| F2 | Every extension copies the whole parent | `src/compiler.ts` `cloneCheckedBook`, then `book_valid(book, done)`'s old install path | O(prefix) work and memory per step; shared term objects are still written by later compiles |
| F3 | A second import parser and namespace rule | `bend/Source.bend`, `bend/Graph.bend`, `App.path.*`, `App.import.namespace`, `Host.resolve`, `Host.realpath` | Any disagreement with the checker's loader (header comments, `import Base` placement, `0x` hub paths, `.bend` checks, normalization, realpaths) checkpoints prefixes the checker never loads |
| F4 | Prefix keys follow import edges, not the checker's load order | `App.prefix.*`, `Graph.loop` | A checkpoint must be a state a cold check reaches: only a prefix of the entry's load order is. Seeding otherwise changes verdicts (the fork's `--checkup` accepted a file cold rejects until `f0568d4f`). |
| F5 | A law declared in a parent and filled with a foreign or `@unsafe` def in a child | resumption in general | Cold parse-all lets the fill's `i`/`u` reach the law's declaration check; a checkpoint taken before the fill was checked without it. Such a boundary must not be resumed across (the U1 decision: keep cold semantics). |
| F6 | The speedup is 2.2× where checking would allow ~20× | `HANDOFF.md` benchmark (67 s against 148 s, wall time) | On the private workload the entry file is 4.9% of check CPU and re-parsing the whole prefix 0.37%, so decode, raise and validation of the restored state dominate |
| F7 | The stability recheck rebuilds the whole graph | `App.*.recheck` | 2× graph cost on cold builds; a traversal-only walk is milliseconds |
| F8 | Every step is judged for open work | `src/compiler.ts` `bookReadAtNamespace` (`holes = book.hols + book.open`, per step) | A law declared in one file and filled in a later one leaves the earlier step open, so the MVP rejects a program the cold check accepts. Reproduced on `80ffd6d1`: `P.bend` declares `law L`, `A.bend` imports it and fills it; `bend A.bend` prints `7n`, `poc build A.bend` fails with `1 TODO found`. |

## Target design

### 1. Load order from the checker

- New capability `Host.load_steps(entry) -> IO(Result<String, List<LoadStep>>)` with `LoadStep{path: String, namespace: String, bytes: String}` (bytes base64, as `SourceFile`). The host implements it with one call: `Bend.book_load(Bend.book_nil(), entry, "", new Map(), undefined, (real, ns, text) => { steps.push(...); return true; })`.
- `Source.bend`'s import grammar, `App.path.*`, `App.import.namespace`, `Host.resolve` and `Host.realpath` leave the key path. The only import parser is the checker's.
- The `PROOF.bend` rule reads whether `LAWS.bend` sits beside the entry: the host reports that fact with the steps, and it is folded into the key.

### 2. Keys

- **Compiler key:** unchanged (`App.compiler_key`), including the Bun version and, for a store build, the executable's identity.
- **Prefix chain:** `P_0 = compiler key`; `P_k = Sequence.snoc(P_{k-1}, Key.step(namespace, path, digest(bytes)))` over the kernel's steps. A checked state at boundary k is keyed by `P_k`: it is exactly "the checker after the first k files of this entry's load order". A changed file, retargeted symlink, moved entry or new `LAWS.bend` changes the chain from that step on, so a stale state is never found.
- **Artifact key:** the final state key, the target, and the foreign inputs the checked records name (`def.i`), whose bytes the host reads after the load.
- Absolute realpaths are part of the key, so states do not move between checkouts at different paths (a non-goal).

### 3. Resumption and sealing

- **Find:** walk the steps (1), compute `P_1..P_n` in Bend, and look up the longest stored `P_k` (the existing `Host.state_get_longest` with chain keys).
- **Resume:** restore the state at `P_k`, then `child = Main.book_over(parent)`, `seen = new Map(parent.seen)`, `done = child.order.length`, `Bend.book_load(child, entry, "", seen, undefined, on)`, `Bend.book_valid(child, done)`. The loader skips every file already in `seen` and parses the rest in load order; `on` records each new file's first event (`child.order.length` at the call), which delimits the boundaries to seal.
- **Judge the entry, not the steps (F8):** a step with holes or open laws is a valid state to seal and resume from. Only the entry's final state is judged: `hols + open > 0` fails the build with the cold text (`Error: N TODOs found.`). A `book_over` child carries its parent's counts (fork `80ffd6d1`), so the final count is the cold one.
- **Seal (F5):** boundary j is sealed only if no law declared at or before j has a fill after j carrying `i` or `u`. The host reports, per step, the fills in that step of laws declared in earlier steps and their flags; Bend decides. On the public corpus no case crosses a file; on the private workload none exists at all.
- `cloneCheckedBook` and the `unsafe_seed` path go away; the fork retires `unsafe_seed` after this migration.

### 4. Stored states (no elaborations)

- **Per definition:** the lowered type and body (`term_lower` at seal time, never on the check path; lowering then raising is idempotent on committed types and bodies: 76,730 types and 53,710 bodies checked), ADT and constructor types, flags (`b`, `u`, foreign paths as realpaths), and a reporting summary (the names its type and elaboration reference, computed with a visited set; flags read from the current view when reporting, since a child's foreign or `@unsafe` fill can make parent definitions rely on it).
- **Per state:** event order, the loader's `seen` map, the counts of holes and open laws (`hols`, `open`; a child starts from them), the instance tables (`tmps`: template, key, name) with each instance's lowered type and body.
- **Elaborations are not stored** (F1). See 5.
- **Restore lazily:** tables whose properties decode and raise a definition on first access. They must keep writable properties, because a child installs names by assignment and JavaScript refuses an assignment that would shadow a non-writable property or a setter-less accessor on the prototype chain: use accessors whose setters define an own data property on the receiver, or materialize into data properties.
- **What a step stores:** after `book_valid`, a `book_over` child's own table keys are exactly its step's records: its events' names (a fill's copy of its law included) and the instances minted while checking them (all 802 checked Base-first public tests; 46 mint instances). A pack stores those, so a state is its chain of packs. Instance tables are copied per child (numbering continues), so a step stores the entries its parent's tables lack.
- **Encoding:** canonical, versioned, with golden vectors; one pack per sealed boundary (per-object files cost ~80 µs of CPU each against ~2.4 µs to append to a pack). The existing SHA-256 storage checksums remain integrity checks, not provenance (see 7).

### 5. Compilation from a restored state

- **First version:** on an artifact miss, compile from a cold load of the entry, exactly as today's cold path. Correct, and check-only workloads never pay it.
- **Next:** re-elaborate only what `main` reaches, replaying `book_valid` in event order and checking reachable definitions under their event-time visibility (needs a small kernel filter in the fork).
- **Or (decision below): store elaborations safely.** It needs the (node, depth)-cached lowering the fork now has, a sharing-preserving encoding, and a level-preserving raise in the kernel (free checker levels become `Var(k, i)`, not global references). A round-2 prototype of that raise compiled 1,057 of 1,057 public programs byte-identically.

### 6. Stability recheck (F7)

Replace the graph rebuild with a second traversal-only walk after checking, comparing the chain. It is milliseconds, so it can run on every build.

### 7. Trust

A content key proves which inputs a state claims, not that the checker produced it: anyone who can write the store can forge a state under a key. Choose between (a) a single-user store, trusted by file permissions, and (b) Ed25519 signatures from a signer process that never evaluates program code (the process that checks can run it: `io_run` evaluates emitted JS). HMAC does not separate verifying from forging.

### 8. GC

Bend emits the live-key set per build (the MVP's next step 3); host GC deletes only what no retained state or artifact references, and publication writes a state's packs before its root.

## Acceptance

- **Cold equivalence.** For the fork's public corpus and for `bend-categories` entries: verdicts, diagnostics, reports and artifacts byte-identical between cold and incremental builds, including after an entry edit, a final-module edit, a failed extension, a symlink retarget, a `LAWS.bend` appearance and a branch from an old state, and for a law filled by a later file and a prefix that leaves a law open or a hole. The fork's `tests/snapshot/` fixtures are the first cases.
- **Restart.** Seal in process A; restore, check and build in B; restore independently in C.
- **Resources** (measured on a quiet host, CPU as user+sys, memory as peak process-tree RSS):
  - persistence overhead (walk, key folding, lookup, restore, sealing) ≤ 10% of a cold check's CPU;
  - an entry-only edit on the private workload close to its checking share (4.9% of a full check);
  - peak RSS ≤ 3× a cold check's;
  - the `HANDOFF.md` benchmark rerun against its 67 s / 148 s.
- **Structure.** Zero copies of parent records per extension; zero re-checked prefix events; zero elaboration bytes stored.
- **Where incremental reuse cannot help.** `spans-pentagon` (one 616 KB entry file whose 22 definitions hold the whole generated proof) spends essentially all of its time checking that entry: 328 s of user CPU at `163230d1` and 329 s with `a583f801`, identical output. Reusing its prefix saves only Base and four small imports; an edit to the entry re-checks the proof. Speeding it up is a checker problem, to be profiled separately.

## Milestones

1. **Import the fork** (this branch, done): `bend-src` is pinned to the fork's `80ffd6d1`, and the MVP builds and passes its install check unchanged. When milestone 3 starts calling `Main.book_over` and `Main.book_flat`, `src/compiler.ts`'s capability check adds them.
2. **Load order and keys:** `Host.load_steps`, chain keys in Bend, removal of `Source.bend` import parsing and the path and namespace rules, the traversal-only stability recheck.
3. **Resumption:** `book_over` in `Host.book_read_suffix`, per-step boundaries from `on`, the sealing rule, and one TODO judgment of the entry's final state (F8).
4. **Stored states:** the codec of 4 (dropping `e`), lazy restore, packs, golden vectors.
5. **Compilation:** the first version of 5; then the chosen next step.
6. **Trust and GC:** 7 and 8.
7. **Acceptance:** the measurements above.

## Open decisions

- **Compilation after restore (5):** re-elaborate reachable definitions, or store elaborations with a level-preserving raise. The first keeps the store small; the second keeps incremental builds fast when `main` reaches most of the prefix.
- **Trust (7):** single-user or signed.
- **Proof scope:** which properties of the key algebra (`Merkle.bend`'s catamorphism, the prefix chain) the `bend-categories` proofs cover.

## Importing the fork commits

`bend-src` follows `github:o1lo01ol1o/bend/expose-book-state-api`, locked at `80ffd6d1` through `flake.lock`. A later fork commit comes in with `nix flake update bend-src`.
