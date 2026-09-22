# Handoff: bend-proof-of-compile

Status as of this document: **working end-to-end MVP with reusable import-prefix
checkpoints**. The Nix installCheck proves cold build, longest-valid prefix
fallback after a late import changes, cache-hit artifact restoration, runnable
output, and clean cache verification.

## What this project is

A content-addressed partial compiler ("proof of compile") for Bend 2. Every
compilation input (compiler identity, hash-library identity, source files,
import edges, foreign files, checkpoints, targets) is folded into Merkle keys.
Cache keys *are* proofs: a hit means the checked compiler state / artifact was
produced from exactly those inputs. Artifacts and checked compiler states live
in a content-addressed store (CAS) under `$TMPDIR/bend-proof-of-compile/v1`.

## The one architectural rule (user constraint)

**All semantics live in Bend. TypeScript is only a capability host.**

TS may: read files, resolve paths, manage CAS bytes, spawn the Bend checker,
interpret the compiled Bend IO program. TS may **never** compute a cache key,
parse source semantics, decide invalidation, or know what a digest means. All
hashing goes through the vendored `bend-hashes` package imported by Bend code.

Second user constraint: `bend-categories` is used to *prove* the categorical
semantics (catamorphism/initial-algebra structure of the Merkle keys), and is
**removed before publishing**. It is already a flake input; see "Next steps".

## File map

### Bend (the application — this is the product)

- `bend/Merkle.bend` — domain-separated Merkle key constructors over a binary
  initial algebra (`Empty | Leaf{domain,payload} | Fork{domain,payload,l,r}`).
  `Merkle.digest` is the catamorphism. `Sequence.empty/snoc` is the ordered
  collection fold. `Key.*` smart constructors: `file_bytes`, `compiler`,
  `named_input`, `import_base`, `import_hub`, `import_local`, `foreign`,
  `source`, `prefix_start`, `prefix_step`, `entry_state`, `artifact`.
  Imports `../vendor/bend-hashes/sha2_32.bend as Hash` (SHA-256).
- `bend/Source.bend` — *pure* parser for the Bend import grammar: leading
  `import Base` / `import ./X.bend [as A]` block, plus foreign
  `import "./x.js"` lines collected from anywhere in the file. The host frames
  source bytes into raw lines to avoid generated-JS stack overflow on large
  `bend-categories` files; all lexical and dependency decisions remain here.
- `bend/Host.bend` — foreign capability declarations. `Checkpoint{token}` and
  `Stage{token}` are affine wrappers (`type ... is Type`) around opaque host
  values — Bend cannot forge or duplicate checked state or a publication
  transaction. `CompileStep` and `ResumeCandidate` are Bend-produced plans
  mechanically interpreted by the host.
- `bend/Graph.bend` — explicit, **fuelled** work-list state machine producing
  the source DAG in post-order (children finalized before parents), with cycle
  detection and source-key computation. Returns `IO(Result<String, Graph>)`.
- `bend/App.bend` — orchestration as explicit IO continuations:
  `App.build` = compiler key → graph build → artifact restore? → final-state
  lookup? → longest valid import-prefix lookup → suffix plan execution →
  **stability recheck** (rebuild graph, compare root key) → atomic publication
  of staged checkpoints → artifact build + CAS put. Prefix keys, ordering,
  namespace normalization, resume candidates, and suffix plans are all derived
  in Bend. Plus CLI parsing (`Cli.run`, `Cli.program`, `main`).

### Foreign boundary (embedded into generated Bend JS)

- `foreign/host.js` — the only JS allowed inside compiled Bend programs.
  Translates to/from Bend constructors (`{$:"Con",...}` lists, `Done/Fail`,
  `Maybe`, `Checkpoint`). Reads the `globalThis.POC_HOST` capability object.
  **All effects are synchronous** (see gotchas).
- `foreign/host.c` — deliberate stub; a native build should fail at link time
  rather than silently change semantics.

### TypeScript host (capability layer only)

- `src/cli.ts` — entrypoint. Imports `dist/app-lib.js`, converts argv to a
  Bend list, and runs the `$FFI` operation loop. Also defines the
  `io_out`/`io_bytes`/`io_tup` globals that `js_lib` output needs (the lib
  emitter does not bundle the full runtime preamble).
- `src/host-preload.ts` — `POC_HOST` implementation: temp cache root, CAS
  layout `objects/<aa>/<key>/{meta.json,state.bin|artifact.bin}` with SHA-256
  *storage* checksums (integrity only — content keys come from Bend),
  quarantine-on-corruption, provisional checkpoint stages committed only after
  Bend's stability proof, conservative GC (temp files only; never guesses
  reachability). `compilerInputs()` uses a single `nix-store-identity` entry
  for `/nix/store` roots (reading the whole compiler tree per build was a
  10-minute slowdown); falls back to full tree walk elsewhere.
- `src/compiler.ts` — wraps the pinned Bend compiler (`bend2` source dir):
  `bookRead` supports an explicit loader namespace so a direct import can be
  checked as the next prefix slice; `compileJs`, `compileC`, and
  `compileLibrary(book, roots)` retain the compiler's export rules.
- `src/compiler-worker.ts` — synchronous child process around `book_read`.
- `src/codec.ts` — gzip+JSON codec for checked `BookState` checkpoints
  (term lowering, span interning, schema version, size caps, full shape
  validation on decode).
- `src/build-bend-lib.ts` — builds `dist/app-lib.js` via
  `compileLibrary(checked.book, ["Cli.program"])`.

### Nix

- `flake.nix` — packages: `bend` (pinned branch
  `o1lo01ol1o/bend/expose-book-state-api`, wrapped over bun), `bend-hashes`,
  and `proof-of-compile` (checks Bend source, compiles `dist/app-lib.js`,
  wraps `src/cli.ts` with `POC_APP_LIB`/`POC_BEND2_SOURCE`/`POC_HASHES_SOURCE`
  env, `poc` symlink, installCheck smoke test). `apps.default` runs it.
  checks: `bend-categories` + infrastructure smoke. `vendor/bend-hashes` is a
  gitignored local symlink for editor/CLI convenience; Nix is the source of
  truth.

## Verified behaviors

- `bend bend/App.bend --check-only` and `bunx tsc --noEmit` pass.
- The installCheck now uses `Base`, `A`, and `B`; after changing only `B`, debug
  evidence is `resumePrefix rank=1 remainingSteps=1` and
  `compileSuffix steps=1 seeded=true`. An exact rerun restores the artifact;
  the artifact runs; `cache verify` reports zero quarantined.
- Manual longest-prefix test independently reproduced the same rank-1 fallback
  and suffix length. Corrupting the longest checkpoint quarantined it with
  `CAS payload digest mismatch`, fell back to the next valid prefix, rebuilt
  one suffix step, and left all resulting CAS objects valid. A separate
  corrupted-artifact test likewise quarantined and rebuilt from the final
  checked state.
- A writable, separate copy of `bend-categories` was tested with a wrapper that
  imports `Category/Monoidal/Instance/Setoids.Unsafe.bend` (48-node, ~868 KiB
  transitive source graph). After an entry-only edit, the longest prefix hit at
  rank 0 with zero remaining import steps. Incremental wall time was **67.44s**
  versus **148.67s** for a cold build of the exact edited source: **54.6% less
  wall time / 2.20× throughput**. The incremental and cold artifacts were
  byte-identical, executed successfully, and all six warm-cache objects passed
  verification. Benchmark workspace: `/tmp/poc-bend-categories.UDtVzi`.

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
10. **Async foreign functions deadlock the runtime.** The compiled IO loop
    has no mechanism to await a promise except chan/time parking. We spawn a
    synchronous child (`Bun.spawnSync`) for `book_read`.
11. **`js_lib` only exports pure non-IO defs by default**, and compiling *all*
    defs can hang. Export exactly the IO entrypoint (`Cli.program`) and drive
    the `$FFI` op loop from TS.
12. **bend-hashes BLAKE3 never terminates** in practice (tested: hangs on
    ~200 bytes). SHA-256 via `sha2_32.bend` is ~50-100ms per `Key.*` op —
    acceptable. **Do not import `main.bend`** (the full facade): typechecking
    jumps from ~10s to ~4min.

## Environment gotchas

- Another session's `bend-categories` check scripts
  (`/private/tmp/claude-501/.../scratchpad/chain*.sh`) periodically spawn many
  parallel `bun ... main.ts --check-only` processes that saturate the CPU and
  make everything look hung. Check `ps aux | sort -rk3 | head`. `pkill -f
  '/bend2/main.ts --check-only src/Categories/'` clears them; the parent
  scripts respawn, so expect recurrence.
- Prefer fixed store paths in one-off commands to skip flake re-eval:
  bend `/nix/store/fb1d6jdzkq0nrzdmhc0c3vn9w9x730hs-bend-2.0.25-unstable`,
  bun `/nix/store/9nmsidbfpjv43b5pzw0sbhpaz6mgc9v8-bun-1.4.2` (re-derive with
  `nix build` if inputs change).
- `warning: SQLite database '/nix/var/nix/db/db.sqlite' is busy` is harmless
  under concurrent nix builds.

## Commands

```sh
# Source of truth build + smoke test
nix build .#proof-of-compile

# Iterate on Bend source
/nix/store/fb1d...bend.../bin/bend bend/App.bend --check-only

# Rebuild the compiled library used by the CLI
bun src/build-bend-lib.ts /nix/store/fb1d.../share/bend/bend2 bend/App.bend dist/app-lib.js

# Run the CLI directly
POC_APP_LIB=$PWD/dist/app-lib.js \
POC_BEND2_SOURCE=/nix/store/fb1d.../share/bend/bend2 \
POC_HASHES_SOURCE=$(realpath vendor/bend-hashes) \
bun src/cli.ts build path/to/Main.bend --output out.js --target js
bun src/cli.ts cache status|verify|gc

# TS typecheck
bunx tsc --noEmit
```

`POC_DEBUG=1` turns on host-call tracing and reports the selected prefix rank,
remaining suffix length, and whether suffix compilation was seeded.

## Next steps (priority order)

1. **Categorical proofs via bend-categories.** Model the Merkle functor
   (`F(X) = 1 + (String×String) + (String×String×X×X)`), show `Merkle` is its
   initial algebra and `Merkle.digest` the mediating morphism into the Digest
   algebra; frame `Sequence.snoc` folds and the key constructors as algebra
   structure maps. `Functor/Algebra.bend` (safe F-algebra records) and
   `Category/Construction/F-Algebras.Unsafe.bend` (the category + laws) in the
   vendored `bend-categories` source are the entry points. **Remove the
   dependency before publishing** (hard user requirement).
2. **Hub imports** (`0x...`): parsed and keyed (`Key.import_hub`) but resolve
   to no target; needs real hub resolution at the host boundary.
3. **GC manifests.** `cacheGc` only removes temp files; Bend should emit the
   live-key set per build (e.g. per-entry manifests) so GC can prove
   unreachability instead of guessing.
4. **Cheaper stability recheck.** Currently rebuilds the whole graph after a
   miss to prove inputs didn't change mid-compile; correct but 2× graph cost
   on cold builds.
5. Publishing cleanup: decide fate of `POC_DEBUG` proxy, `dist/` artifacts,
   and the `vendor/` symlink.
