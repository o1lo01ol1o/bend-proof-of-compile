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
2. **Load order and keys** (done): `Host.load_steps`, chain keys in Bend, removal of `Source.bend` import parsing and the path and namespace rules, the traversal-only stability recheck.
3. **Resumption** (done): `book_over` in `Host.book_check`, per-step boundaries from `on`, the sealing rule, and one TODO judgment of the entry's final state (F8).
4. **Stored states** (done): the codec of 4 (dropping `e`), lazy restore, packs, golden vectors.
5. **Compilation** (done: the first version, then re-elaboration of what `main` reaches, fork `16379eb7`): the first version of 5; then the chosen next step.
6. **Trust and GC** (done, trust as (b)): 7 and 8.
7. **Acceptance** (done; results below): the measurements above.

## As built (milestones 2–7)

Where the implementation settles something this spec left open, or departs from it:

- **One `book_over` child per sealed group, not one per suffix.** A child's own tables are its records only if it checks one step's events: in a single child over the whole suffix, an instance minted while checking step j+1 cannot be attributed to a step, and a state sealed at j that kept it would number later instances differently from cold. Each group loads with the `on` hook parsing its own files and skipping (then forgetting) every later file, then `book_valid`s; its pack is the child's own records, so packs (4) came with this milestone. Consecutive unsealed boundaries share a group.
- **Sealing facts come first, from a parse-only load of the whole order**, before the longest-state lookup, so only sealed boundaries are offered for resumption; a law declared before a stored boundary and filled after it with a foreign or `@unsafe` definition makes that boundary unusable for this entry even if another build sealed it. The parse costs about the spec's measured re-parse share, and is skipped when the final state or artifact is found.
- **The PROOF.bend rule is judged by Bend on every build**, from the host's observation (`PlainEntry | ProofEntry{laws}`), after the parse pass on a miss (so a parse error still comes first, as cold) and before an artifact is restored on a hit. It is not folded into a key: a final state `P_n` stays shareable, and the verdict cannot go stale.
- **The artifact key's foreign inputs** come from a manifest in each state's CAS metadata: the `def.i` files its whole chain names, so an artifact hit needs no restore.
- **A step is keyed by the text the loader read** (`LoadStep{path, namespace, text}`, `Key.file_text`), the checker's actual input, rather than by base64 bytes: a quarter less to hash, nothing to encode. Every file a check reads must equal its keyed step, or it fails as unstable, so a state is never stored under inputs it was not checked from.
- **The checker runs in the host process.** `src/cli.ts`'s IO loop awaits a capability that returns a promise, so `book_load` is called directly; the per-step child process and its seed encode/decode are gone.
- **The stability recheck compares observations, not chains.** The second walk's files, namespaces, texts and PROOF.bend observation must equal the first's, compared in Bend by tail calls (base `String.eq` is not tail-recursive and overflows on a 200 KB file). Equal observations fold to the same chain, and comparing costs a fraction of folding again; it also covers a `LAWS.bend` appearing mid-build, which the chain does not.
- **Hashing is faster, still through bend-hashes.** The vendored SHA-224/256 read a block's words by indexed list reads and rebuilt its schedule list per word (about 0.24 MB/s). `nix/patches/bend-hashes-sha2_32-streaming.patch` replaces its internals, keeping its functions and digests: words read four bytes at a time, a sixteen-word window sliding one word per round, constant shifts, tail calls only (about 1.6 MB/s; `test/sha.test.ts` checks it against Node's on NIST vectors and every padding length).
- **Packs (4).** A stored definition keeps its lowered type and body, flags (foreign paths as realpaths) and `r`, the report's summary: the names its types and elaboration refer to. Elaborations are not stored (F1). Encoding is canonical (tables sorted by name) and versioned (schema 3); `test/golden/` pins it, and decode-then-encode is the identity on each golden pack. A pack also records `last`, where its last file's events begin: the loader's mark when that file is an entry, which the report needs.
- **Restore is lazy (4).** A chain restores into one flat table of accessors: a record is raised on first read and becomes a data property, and the setter makes an assignment through a child table (a fill of a restored law) the child's own property. The report reads flags and summaries from the wire without raising anything.
- **Compilation (5): decided, re-elaborate what `main` reaches.** A state checked from nothing in this process is emitted directly. A state with restored records is replayed: `book_valid(book, 0, only)` (fork `16379eb7`) reveals every event in order as a cold check does, checks only the events in `only`, and, during the replay, re-elaborates a stored instance at its first call. `only` is what `main` reaches through the records' summaries, closed under the callers of every template instance in it, so each instance's earliest caller is replayed and re-elaborates it at the view that minted it cold (a law filled between an instance's mint and a later call would otherwise change its elaboration). The first version (a cold emit) came first and was replaced. Artifacts carry the report of the build that made them, so an artifact hit notes it again; `poc check ENTRY` is the check-only workload.
- **Why not stored elaborations.** Elaborations are not data: on the heavy benchmark they hold 87,121 closures (`All.B`, `Lam.f`) among 1.35 M shared nodes, so storing them needs the kernel's level-preserving raise and lower plus a sharing-preserving encoding (88 MB of JSON, 9 MB gzipped, ~1.4 s to encode, for that one entry), where the replay needed a filter and keeps "zero elaboration bytes stored".
- **Reports and the output rule are the checker's.** `poc check` prints `cli_report`'s text on stdout and `poc build` notes it on stderr, from the entry's own claims (`n0`), with promises flooded back through the summaries; `poc build` refuses an output that is a loaded file, a foreign file or a directory, with the checker's text.
- **Trust (7) is (b), signed states.** `src/signer.ts` is the only process that reads the Ed25519 signing key (created on first use, mode 0600, and trusted); it never loads the checker, the application or any program code, and signs the statements `poc` hands it at publication, one call per stage. A statement is an object's whole metadata but the signature (kind, key, payload SHA-256 and size, and the parent pack and foreign files, or the report), under a domain tag. Every read verifies it against the trusted keys: a signature that does not verify is quarantined; a valid one by a key that is not trusted is a miss, left in place, and replaced when a trusted build writes that key; `poc cache verify` counts both. `signer.ts public` prints a signer's key and `signer.ts trust KEY` trusts another's, so a cache one signer fills (CI) is read by others (developers). Integrity no longer rests on directory permissions, so the "cache must be private" refusal of (a) is gone (the cache is still created 0700). The signer is a separate process but runs as the same user: code running as that user can read the key and sign, so (b) protects caches shared between users and machines, not against the local user (the separate-user daemon was considered and not taken). The cache moved to `v3`; CAS metadata is schema 3.
- **GC (8).** Each build records its live keys (the final state; and the artifact when it emits) under a root Bend names per entry and purpose (`Key.root`); `poc cache gc` takes the union of all roots, keeps each live state's chain of packs, and deletes every other object. Packs are published parents first. A build racing GC can lose a parent it meant to extend; the chain then fails to restore, which is a miss.
- Removed with the second import parser: `--base` (the checker always loads its own `base.bend`), `Host.realpath`, `Host.resolve`, `Host.read_source`, `Host.default_base`. The cache moved to `v2`; CAS metadata is schema 2 (later `v3` and schema 3, with signatures).
- **Report duplication.** The report mirrors `main.ts`'s `cli_report` over summaries (`src/compiler.ts`), because the fork does not export it and restored records have no elaborations to walk. Exporting a summary-parameterised report from the fork would leave one implementation.

## Acceptance results

- **Cold equivalence.** The fork's whole `tests/` corpus, cold then warm over one shared cache (`tools/cold-equivalence.ts`): 2,870 `--check-only` comparisons and 1,888 `-o out.js` comparisons, byte-identical stdout, stderr, exit status and artifacts. bend-categories' tests, `PROOF.bend` and benchmarks: 40 and 12, identical. The histories (entry edit, final-module edit, failed extension, symlink retarget, `LAWS.bend` appearing, branch from an old state, law filled later, open law and hole prefixes) are `test/acceptance.test.ts`, each step against the CLI.
- **Restart.** Every history step is its own process; a second entry restores the first's prefix states.
- **Resources** (bend-categories heavy benchmark, 50 files, 955 KB, cold `--check-only` 6.0 s and 0.45 GB; the private workload was not available here): peak RSS at most 1.8× a cold check's (met); an entry-only edit checks in 1.1–1.3 s (19–21% of a full check, most of it key folding over 955 KB of text); a cold check with every boundary sealed takes 8.6–8.9 s, so persistence overhead is about 40% on this text-heavy, check-light workload (not met here: key folding ~0.7 s, sealing ~0.4 s); the `HANDOFF.md` benchmark (MVP 67 s / 148 s) is now 1.1–1.3 s / 8.6 s for a check, and 8.2 s for a build after an edit, a figure from 5's first version (a cold emit); with the replay, a build after an entry edit takes 1.4–1.5 s (JS and C byte-identical to `bend -o`).
- **Edit round** (heavy benchmark, each step against the CLI, all outputs identical): an edit to the entry or a late module checks in 1.0 s and builds in 1.4 s against 6.0–6.2 s cold (4–6×); a revert or no-op takes 1.0–1.9 s; an edit before the expensive file (step 33, or step 3) costs a cold `poc` check, 8.3–9.0 s against the checker's 6.2–6.6 s. Checks over a restored parent first ran ~60% slower than over the same parent in memory; interning restored names as atomized strings (`src/codec.ts`) made them equal.
- **Structure.** Zero copies of parent records (children are `book_over` tables); zero re-checked prefix events (a group loads only its own files); zero elaboration bytes stored (the codec tests assert it).

## Open decisions

- **Hashing throughput: decided** — keep the rule and accept the cost. Keys over file text are computed in pure Bend with bend-hashes (streaming patch): about 0.6 s per MB of source per build, most of a no-op or entry-only build's time on text-heavy, check-light workloads such as the bend-categories heavy benchmark, where the 10% overhead target is therefore not met. Not taken: host-supplied digests (break the rule) and digests remembered by file stat (a hit would mean "stat matched", not "these bytes").

- **Compilation after restore (5): decided** — re-elaborate what `main` reaches (see As built). A build after an edit re-checks that much of the prefix; when `main` reaches most of a large prefix, it approaches a cold check.
- **Trust (7): decided** — (b), signed states, with a signer subprocess (see As built).
- **Proof scope:** which properties of the key algebra (`Merkle.bend`'s catamorphism, the prefix chain) the `bend-categories` proofs cover.

## Importing the fork commits

`bend-src` follows the fork's `expose-book-state-api` branch. It is locked at `16379eb7` (book_valid's replay) from the local checkout (`git+file:///Users/timpierson/Work/bend`) until that commit is pushed; then the input returns to `github:o1lo01ol1o/bend/expose-book-state-api`. A later fork commit comes in with `nix flake update bend-src`.
