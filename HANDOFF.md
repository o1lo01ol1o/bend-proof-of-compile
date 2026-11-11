# Handoff: bend-proof-of-compile

## Status (2026-11-11): on upstream v2.0.40

poc runs on the fork's `main`, which carries the poc series on v2.0.40 (tag
`poc/2.0.40+poc.6`, `3d725059`; `bend version` prints `2.0.40+poc.6`).
`bend` and `poc` run on a 64 MB stack (`ulimit -s` plus
`BUN_JSC_maxPerThreadStackUsage`): the C lane recurses once per element of
a list literal.
`flake.nix` tracks the fork's `main` and `flake.lock` holds the revision;
the version string is read from the locked source. This branch is `main`
on GitHub, and bend-categories tracks it. `nix build
.#proof-of-compile` passes: 39 tests (codec, stored elaborations, runtime, SHA,
acceptance histories against the fork's CLI) and the install check.

- **Stored elaborations (pack schema 9, CAS schema 5, cache `v5`).** A
  state object has two payloads under one key and one signature: the state
  (`state.bin`: records, summaries, order, sources; each record's lowered
  type and value travel as one compressed blob, inflated on the record's
  first read, so a restored chain holds its records' terms at their
  compressed size: one module's 55-pack chain is 260 MB of term JSON, 24 MB
  compressed, and restoring it without raising a record went from 1.7 GB
  resident to 0.3 GB; the warm `poc check` of that module went from 4.8 GB
  to 3.4 GB, the rest being outside the codec, most likely the Bend-side
  hashing of the order's source texts) and its elaboration
  (`elaboration.bin`: one term table,
  `src/term-table.ts`, holding every node of every checked body and every
  cell value lowered at its binder depth, once per distinct content and
  without spans, plus each valued definition's body root). A definition with
  a value always has its body (the codec refuses otherwise); a declaration
  never has one. A check never reads an elaboration: restoring a chain
  parses states only, and a definition's `e` is a lazy field that reads and
  parses its pack's elaboration on the first body a build compiles from that
  pack. Before the split, restoring bend-categories' 1,091-link chain held
  14.9 GB for a 6-second resume. Spans are what made elaborations big: on
  `Interchange/Braided_Unsafe.bend` (1,020 bodies, 11.7 M body nodes, 3.9 M
  cells) the table holds 484 K nodes (23.5 MB of JSON) where the same
  content with spans is 26 M; the compiler reads no span of a body or type
  and keys types span-free. Cost: encoding that module takes ~36 s against a
  3.5–5 s check (3.5 s of it the kernel's lowering), with no memory above
  the check's own peak; `demos/app_slash_boss_3d` encodes in 0.36 s against
  a 0.24 s check; decoding a whole module is under a second. There is no
  replay, and `prepare_book` and `book_valid(…, only)` are unused.
  `test/term-table.test.ts` checks byte-identical C and JS over six programs
  (Base's bodies included), a stable encoding after one round trip, and
  emission from a state restored through real packs; `test/codec.test.ts`
  pins both golden texts, that a check never reads the elaboration, and
  that an elaboration naming the wrong definitions is refused.
- **Layered stores.** `POC_STORE` names the writable store (else
  `$POC_CAS_ROOT/bend-proof-of-compile/v5`, `POC_CAS_ROOT` absolute, as on
  main since e7b4ab6; else `$TMPDIR/bend-proof-of-compile/v5`) and `POC_STORE_PATH`
  read-only stores searched after it; a Nix store path, or a `symlinkJoin`
  of several, is one layer. Writes, GC, verification and quarantine act on
  the writable store only; an invalid object in a layer is a miss. Keys name
  files by real path, so a layer serves a reader that checks the same real
  paths (in Nix: the same source store path). The acceptance test "a
  read-only store layer serves states and artifacts" pins this; trust is
  unchanged (signatures against the reader's trusted keys), pending D9 in
  `docs/SPEC-persistent-artifacts.md`.
- **`poc plan [--module] FILE`** prints the load order a chain of boundaries
  follows, one step per line as `namespace<TAB>realpath`, Base first and the
  entry last; a flake materializes it (committed, checked for drift) to
  define one derivation per dependency region without import-from-derivation.
- **Pack schema 9: a def keeps its module's namespace (`m`).** A foreign
  def's C names ids as `CID(k)`, which the emitter resolves in the def's
  own module (comp.ts `c_ids`); schema 8 dropped `m`, so C emitted from a
  restored state looked `k` up bare and died ("CID(tick) names no
  constructor or def"). A check and `bend -o` never restore, which is why
  only a restored emit (poc build after a check, bend-tauri-poly's prefix
  packs) met it. Schema 8 packs are refused, so they are checked again.
  Test: "C from a restored state: a module's foreign C names its own
  module's ids".
- **Every error of the failing file.** The fork's checker no longer stops
  at the first error: `book_check` (main.ts, over `book_valid`'s `past`
  hook; the CLI and poc both call it) goes on to the end of that error's
  file, and no further, so nothing past it is elaborated. A failed def turns
  opaque, and a def whose parsed terms name a failed one is skipped (and
  counted), so each error reported is independent. One error prints as
  before; more print in order, each with poc's `At:` line after it, then
  `Found N errors.` (`book_err`'s `at` places the lines, so poc and
  `bend --check-only` still agree byte for byte). Parse errors still stop at
  the first.
- **`poc unreached [--module] FILE DEF DIR`** checks FILE as `poc check`
  does (through the cache, whatever the verdict: holes, `@unsafe` and
  foreign code are fine), then lists the definitions in the `.bend` files
  under DIR that DEF does not reach, the files there FILE never loads, and,
  apart, what only laws about reached code keep alive. The reach follows each
  record's stored references (`src/unreached.ts`), so it sees what
  elaboration resolved and raises no record: on the suite's Trading plugin
  (451 definitions) it is 103 s cold and 1.3 s warm. A program with several
  entry points (a plugin's `main` and `start`) needs one run per entry.
- **Composition as derivations** (`nix/composition.nix`, `lib.composition
  { pkgs, poc }`). `chain` makes one derivation per region of a load order:
  each checks a synthetic entry importing the hub modules of every region up
  to its own, reads the regions before it as layers, and writes its region's
  objects to its output; `store` joins layers; `build` emits an entry's
  artifact against layers. The flake check `composition` chains a two-module
  hub kit and builds an application against the join: the application checks
  only its own entry, and its artifact is `bend -o`'s byte for byte. A
  dependency must be a hub package (`0x<pkg>/…` under `BEND_LIB`): hub
  namespaces are entry-independent, relative ones are not. Reuse is per
  package pin and along load-order prefixes (`docs/SPEC-persistent-artifacts.md`,
  "Nix composition").
- **Constructor datatypes.** Packs keep `Ctr.f` (2.0.40, bendlang/bend
  #2053); without it a type error over a restored prefix crashed in
  rendering (`k.includes` on an undefined name).
- **Verdict.** Bend's `book_report`: strict by default, `--allow-unsafe` for
  audited contraction. A `Fail` report carries `own` (a reliant def is the
  entry's own or a law).
- The `bend-categories` input is gone; bend-categories follows this flake's
  compiler pin instead.

### Per-release procedure for the fork series

For upstream release `vX` with the series on `poc/<previous>`:

```sh
git -C ~/Work/bend fetch upstream --tags
git -C ~/Work/bend switch -c poc/X vX
git -C ~/Work/bend cherry-pick -x <previous upstream>..poc/<previous>
```

Expect conflicts where conversion (`bend.ts`), the verdict
(`main.ts` `book_promises`/`book_report`) and `io_run` (`comp.ts`) move. Then:
bump `BUILD` in `main.ts`; check the caps (`gates/repo.ts`, `ttok -m
gpt-3.5-turbo`; the fork's `comp.ts` cap is 66,600); run the fork's
`tests/snapshot`, `tests/check/congruence_*` and a differential of every
`tests/` file under `--check-only` against plain `vX` (on 2.0.40: 1,852 of
1,852 identical); push `poc/X` and tag `poc/X+poc.1`; re-pin this flake;
`nix build .#proof-of-compile`; then bump bend-categories' `bend-poc`.

The series' `prepare_book`, `book_valid(…, only)` and replay commits are no
longer used by poc and can leave the series at the next rebase.

## Pre-integration milestone history

Status: **`SPEC-incremental-compilation.md` milestones 1–7 are in**, including
the decided next step of compilation after restore (5): re-elaborate what
`main` reaches, through a replay filter in the fork (`f9b57338`), and trust
option (b), signed states.
Open: the proof scope. Decided and recorded: keep pure-Bend hashing and accept
its cost. `nix build .#proof-of-compile` runs the codec laws and golden vectors,
the hash against Node's, incremental histories against the pinned checker's
CLI, and an install check.

## What this project is

A content-addressed partial compiler ("proof of compile") for Bend 2. Every
input of a check (compiler identity, hash-library identity, the checker's load
order with each file's realpath, namespace and text) is folded into Merkle
keys; an artifact's key adds the target and the foreign files the checked
records name. A hit means the state or artifact was produced from exactly
those inputs. States and artifacts live in a content-addressed store under
`$TMPDIR/bend-proof-of-compile/v4`; every object is signed, and only objects
signed by a trusted Ed25519 key are read.

The checked state after the first k files of an entry's load order is keyed
`P_k` (`P_0` = the compiler key, `P_k = Load.snoc(P_(k-1), step k)`), so any
entry whose load order starts the same way shares it. A build restores the
longest stored, *sealed* `P_k`, checks the rest in `book_over` children of it,
and stores a pack per sealed boundary.

## The one architectural rule (user constraint)

**All semantics live in Bend. TypeScript is only a capability host.**

TS may: read files, manage CAS bytes, drive the Bend checker (whose loader is
the only import parser), supply capabilities to Bend's compiled IO scheduler. TS may
**never** compute a cache key, parse source semantics, decide invalidation, or
know what a digest means. All hashing goes through the vendored `bend-hashes`
package (patched to stream; same functions and digests) imported by Bend code.

Second user constraint: `bend-categories` is used to *prove* the categorical
semantics (catamorphism/initial-algebra structure of the Merkle keys), and is
**removed before publishing**.

## File map

### Bend (the application)

- `bend/Merkle.bend` — the binary Merkle initial algebra and its catamorphism
  `Merkle.digest`; `Sequence.empty/snoc`; key constructors `file_bytes`,
  `file_text`, `compiler`, `named_input`, `step`, `foreign`, `artifact`,
  `root`; `Load.snoc` extends the load-order chain.
- `bend/Host.bend` — capability declarations. `Checkpoint`/`Stage` are affine
  (`is Type`) wrappers of host values. `LoadOrder{imports, entry, rule}` is the
  checker's load order (the entry is its last step); `LateFill` is a law filled
  in a later step than its declaration; `Verdict{todos, reliant, report, unsafe_report}` is the
  checker's judgment of a final state; `CheckGroup`/`ResumeCandidate` are
  plans the host interprets; `OutputPath` is the emit target as the checker's
  CLI resolves it.
- `bend/App.bend` — everything that decides. `Build{entry, cache, compiler,
  mode}` with `Mode = Checking | CheckingUnsafe | Emitting{Emission{output, target}}`. The
  chain and its points; sealing (F5) and grouped check plans; the verdicts
  (PROOF.bend rule, TODO count, the report text, the output rule) with the
  checker's own texts; stability by comparing a second walk's observations;
  GC roots; the CLI (`check [--module]`, `unreached [--module]`, `plan`,
  `build`, `cache status|verify|gc`).
  `check --module FILE` loads FILE as a sibling importer does (namespace
  `X` for `X.bend`), so checking modules bottom-up leaves exactly the
  prefixes their importers resume from; plain `check FILE` loads it as the
  entry (namespace `""`), a different state.

### Foreign boundary

- `foreign/host.js` — the only JS inside the compiled program: registers the
  Bend effects, converts to and from compiler-assigned constructor IDs,
  and calls `globalThis.POC_HOST`. The checker's loader is async: `poc_await`
  returns a promise of the Result, which Bend's scheduler parks and resumes.
- `foreign/host.c` — a deliberate stub.

### TypeScript host

- `src/cli.ts` — preloads host capabilities and imports `dist/app.js`
  (`POC_APP_JS` overrides its path). Bend owns arguments, scheduling and exit.
- `src/host-preload.ts` — `POC_HOST`: private cache root; CAS
  `objects/<aa>/<key>/{meta.json,state.bin|artifact.bin}` with SHA-256 storage
  checksums (integrity only), metadata parsed at the boundary (schema 4, signed: a
  state's parent pack and its chain's foreign files; an artifact's report);
  quarantine on corruption; stages published parents first after Bend's
  stability check; GC roots and reachability GC.
- `src/unreached.ts` — `poc unreached`'s report over a checked state: the
  reach from a def along stored references, laws kept by reached code, and
  the `.bend` files under a directory the load order never loads.
- `src/compiler.ts` — drives the pinned checker in process: `loadSteps`
  (traversal-only walk; on a walk error, the cold load's error), `loadFills`
  (parse-only load; laws filled late, with their foreign/`@unsafe` flags),
  `check` (each group in a `book_over` child, later files skipped by `on` and
  forgotten, then `book_check`), `verdict` (TODO count and Bend's canonical
  `book_report` over lazy summaries of the whole checked book),
  `emit`, `emitRestored`, and the checker's error rendering (`book_err`).
  Restored emission first calls Bend's `Comp.prepare_book(book, target)` to
  elaborate the output wrapper, then replays `book_valid(book, 0, only)` over
  the prepared main's dependencies, closed under instance callers. Wrapper
  generation stays in Bend; its runtime dependencies must be visible before
  choosing replay's reachability set. Replay owns shallow record copies,
  including template instances, because re-elaboration writes `Def.e`;
  checked ancestors and restored snapshots remain immutable. This allocates
  emission-local copies, not retained elaborations or extension-time prefix
  copies. The adapter now requires the `prepare_book` compiler API; old
  compiler packages need a coordinated source/pin update before deployment.
- `src/codec.ts` — packs (schema 4): a sealed boundary's own records without
  elaborations, with reference summaries; canonical; lazy restore through
  accessor properties; summaries readable without raising.
- `src/trust.ts` — statements, public key names, verification; key paths
  (`POC_SIGNING_KEY`, `POC_TRUSTED_KEYS`, default under
  `$XDG_CONFIG_HOME/bend-proof-of-compile/`).
- `src/signer.ts` — the signer: the only reader of the private key (`sign`,
  `public`, `trust KEY`); never loads the checker or program code.
- `src/build-bend-app.ts` — checks and emits the executable `dist/app.js`.

### Tests and tools

- `test/codec.test.ts` — golden vectors (`test/golden/`), decode∘encode = id on
  each pack, no stored elaborations, summaries agree, restored tables stay
  writable, malformed packs rejected (fixture `test/fixtures/pack/`).
- `test/sha.test.ts` — the patched SHA-224/256 against Node's.
- `test/runtime.test.ts` — the upstream scheduler directly: sync/Promise/thenable
  continuation exactly once, rejection and undefined-value errors, mixed native
  timer and TCP descriptor waits, and Promise-only Node execution without bun:ffi.
- `test/acceptance.test.ts` — incremental histories, each step against `bend
  --check-only` and `bend -o`: entry edit, final-module edit, failed extension,
  branch to an old state, law filled later, open law and hole prefixes,
  symlink retarget, `LAWS.bend` appearing, restart across processes, a second
  entry sharing the prefix, signed states, and modules checked bottom-up
  with `--module` (each resumes from the one below; the top entry checks only
  itself).
- `tools/cold-equivalence.ts` — the same comparison over a whole corpus (the
  fork's `tests/`), in parallel over one shared cache, optionally in warm
  rounds.
- `nix/patches/bend-hashes-sha2_32-streaming.patch` — the streaming SHA-2.

## Pre-integration verified behaviors (historical, not rerun on this target)

- `nix build .#proof-of-compile`: `bend bend/App.bend --check-only`, all tests,
  and the install check (Base, A, B, Main; after changing B:
  `resumePrefix rank=1 remainingGroups=2 remainingSteps=2`, `check groups=2
  steps=2 seeded=true`; artifact restore and run; F8; clean verify).
- The fork's whole `tests/` corpus (1,435 files; `--check-only` on every file,
  `-o out.js` on every file with a main, 1,888 emits), cold and then warm over
  one shared cache: identical stdout, stderr, exit status and artifacts
  (2,870 checks and 1,888 emits, 0 disagreements); so do bend-categories's
  tests, `PROOF.bend` and both benchmarks (40 checks, 12 emits).
- GC keeps each root's chain and artifact and removes the rest; `verify` stays
  clean. Signed states: a forged payload (digest recomputed) is quarantined; a
  second signer's objects are misses until its key is trusted, then used
  (`test/acceptance.test.ts`); signing costs one ~10 ms signer call per
  publication.
- `bend-categories` heavy benchmark (`HeavyBenchmark.bend` over
  `Setoids.Unsafe.bend`: 50 files, 955 KB), with another session's checker
  holding a core:

  | Build | Wall | Peak RSS | MVP |
  |---|---|---|---|
  | `bend --check-only` (reference) | 6.0 s | 0.45 GB | |
  | `poc check`, cold (50 packs sealed) | 8.6–8.9 s | 0.76–0.80 GB | 148.7 s cold build |
  | `poc check`, entry-only edit | 1.1–1.3 s | 0.43–0.48 GB | 67.4 s |
  | `poc check`, no-op | 1.0–1.2 s | 0.40–0.44 GB | |
  | `poc build`, after an edit (replay of what `main` reaches) | 1.4–1.5 s | 0.41–0.49 GB | |
  | `poc build`, no-op (artifact restored) | 1.3 s | 0.33 GB | |

  An edit round on the same benchmark (build, then check, each step against
  the CLI; all outputs identical; one core busy with another session):

  | Edit | `poc build` | `bend -o` | `poc check` | `bend --check-only` |
  |---|---|---|---|---|
  | none (cold cache) | 8.6 s | 6.0 s | — | 5.9 s |
  | entry (step 50) | 1.4 s | 6.0 s | 1.0 s | 6.0 s |
  | late module (step 48) | 1.4 s | 6.2 s | 1.0 s | 6.2 s |
  | heaviest module (step 33) | 7.2 s | 6.0 s | 1.3 s | ~6 s |
  | early module (step 3) | 8.3–9.0 s (check) | | | 6.2–6.6 s |
  | revert, no-op | 1.0–1.9 s | 6–7 s | 1.0–1.8 s | 6–7 s |

  Savings are the checking of the files before the edit: 4–6× for edits late
  in the load order; an edit before the expensive file costs a cold `poc`
  check (~2 s over the checker: key folding, fill scan, sealing). Checks on a
  restored parent ran ~60% slower until restored names were interned as
  atomized strings (`src/codec.ts`, `intern`); they now match an in-memory
  parent.

  Artifacts are byte-identical to `bend -o`. Of a cold check's overhead, key
  folding is ~0.7 s, sealing ~0.4 s (mostly the report summaries' walk of
  elaborations), the fill scan ~0.1 s.

## Known history

- `de8102f` (`poc check --module`) was pushed while its Nix build failed: two
  acceptance histories hit the tests' 120 s limit under machine load
  (timeouts, not disagreements). `2c5018f` raises the limit to 15 minutes;
  a forced rebuild then passed all 17 tests, each history in 3–7 s. Skip
  `de8102f` when bisecting with `nix build`.

## Bend-2 authoring gotchas (hard-won, will bite you)

1. **No field access on data.** `node.key` is "not a defined name". You must
   pattern-match: `case Node{path, key, imports}: key`. Add small accessor
   defs (`Graph.node.key` etc.).
2. **Match scrutinees must be parameters or fields.** Matching a local binder
   errors with "a match cannot scrutinize a local binder: give it its own
   def". Factor into helper defs (the `*.step`/`*_state` pattern).
3. **Affinity/linearity is real.** Reusing a `Data`/string twice errors with
   "consumed more than once". Mark the binding `+x` to copy. Pattern binders
   can take `+` too: `case SCon{+head, tail}:`.
4. **`_` in patterns counts as a binder** — two `_`s collide. Use named
   `+unused_foo` binders and drop them.
5. **Self-recursion needs the law pattern:** declare `law Name: for ... T` then
   fill it with `def Name(args):` (no type ascription on the def — it must
   exactly fill the law). Helpers may recurse through the law.
6. **`Bool.pick` is not lazy.** Both branches evaluate — never use it around
   recursion (exponential blowup; this was the 100-second parse). Use a
   matched helper def instead.
7. **No mutual recursion between defs.** Merge variants into one match.
8. **Local binders can't be annotated with `+`;** restructure (recompute, or
   pass through helpers) rather than duplicating a `let`.
9. **Imports of local modules need explicit aliases:**
   `import ./Host.bend as H`, used as `H.Host.read_source`. Quoted module
   imports (`import "./A.bend"`) are foreign-implementation imports, not
   module imports.
10. **Async foreign functions deadlock Bend's own runtime.** The compiled IO
    loop has no mechanism to await a promise except chan/time parking. This
    project drives `$FFI` operations from `src/cli.ts` instead, which awaits a
    promise returned by a capability, so the checker runs in process.
11. **`js_lib` only exports pure non-IO defs by default**, and compiling *all*
    defs can hang. Export exactly the IO entrypoint (`Cli.program`) and drive
    the `$FFI` op loop from TS.
12. **bend-hashes BLAKE3 never terminates** in practice (tested: hangs on
    ~200 bytes). SHA-256 comes from `sha2_32.bend`, patched to stream
    (`nix/patches/`). **Do not import `main.bend`** (the full facade):
    typechecking jumps from ~10s to ~4min.
13. **Names are defined before use.** A def may only call defs above it in
    the file; order helpers first.
14. **A match (and a tuple destructuring) cannot take a computed value.**
    `(a, b) = f(x)` is rejected; pass the pair to a def as a parameter and
    destructure it there (see `SHA2_32.blocks`).
15. **Base's string and list walks are not tail-recursive.** `String.eq`,
    `List.append` and friends overflow the JS stack on ~100 KB inputs; write
    accumulator-passing walks (`App.same.text`, `SHA2_32.onto`).
16. **Constructor names are global.** `Emit` is taken by the IO runtime;
    choose distinct names (`Emitting`).
17. **Nat literals stop at 2^32-1**, and `U32.from_nat` wraps.

## Environment gotchas

- Another session's `bend-categories` check scripts
  (`/private/tmp/claude-501/.../scratchpad/chain*.sh`) periodically spawn many
  parallel `bun ... main.ts --check-only` processes that saturate the CPU and
  make everything look hung. Check `ps aux | sort -rk3 | head`. `pkill -f
  '/bend2/main.ts --check-only src/Categories/'` clears them; the parent
  scripts respawn, so expect recurrence.
- Prefer fixed store paths in one-off commands to skip flake re-eval:
  bend `/nix/store/rryz0gll0z32qrc1j5ba725k48sl672v-bend-2.0.27-unstable` (fork `f9b57338`),
  bun `/nix/store/9nmsidbfpjv43b5pzw0sbhpaz6mgc9v8-bun-1.4.2` (re-derive with
  `nix build` if inputs change).
- `warning: SQLite database '/nix/var/nix/db/db.sqlite' is busy` is harmless
  under concurrent nix builds.

## Commands

```sh
# Source of truth build + smoke test
nix build .#proof-of-compile

# Check and emit the capability application (not a pure proof verdict)
bun src/build-bend-app.ts "$BEND2_SRC" bend/App.bend dist/app.js

# Run the CLI directly
POC_APP_JS=$PWD/dist/app.js \
POC_BEND2_SOURCE="$BEND2_SRC" \
POC_HASHES_SOURCE=$(realpath vendor/bend-hashes) \
bun src/cli.ts check path/to/Main.bend
bun src/cli.ts check --module path/to/Lemmas1.bend   # as its importers load it
bun src/cli.ts unreached path/to/Main.bend main path/to/src   # what main does not reach
bun src/cli.ts build path/to/Main.bend --output out.js --target js
bun src/cli.ts cache status|verify|gc

# TS typecheck and tests (acceptance needs the CLI environment above and BEND)
bunx tsc --noEmit
BEND=$(nix build .#bend --print-out-paths)/bin/bend bun test

# Cold equivalence over the fork's corpus
bun tools/cold-equivalence.ts --emit --rounds 2 ~/Work/bend/tests
```

`POC_DEBUG=1` turns on host-call tracing and reports the rank of the resumed
boundary, the remaining groups and steps, and whether the check was seeded.

## Next steps (decisions first)

1. **Trust beyond (b):** the signer runs as the user, so local code as that
   user can sign; a separate-user signer daemon would close that.
2. Hashing throughput is decided (keep the rule; ~0.6 s/MB of source per
   build); revisit only with a faster Bend SHA-256.
3. **Report duplication:** export a summary-parameterised `cli_report` from
   the fork and drop the mirror in `src/compiler.ts`.
4. **Categorical proofs via bend-categories** (the spec's proof-scope
   decision). **Remove the dependency before publishing.**
5. Publishing cleanup: `POC_DEBUG`, `dist/`, the `vendor/` symlink.
