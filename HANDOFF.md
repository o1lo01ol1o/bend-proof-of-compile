# Handoff: bend-proof-of-compile

Status: **`SPEC-incremental-compilation.md` milestones 1–7 are in**, including
the decided next step of compilation after restore (5): re-elaborate what
`main` reaches, through a replay filter in the fork (`16379eb7`), and trust
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
`$TMPDIR/bend-proof-of-compile/v3`; every object is signed, and only objects
signed by a trusted Ed25519 key are read.

The checked state after the first k files of an entry's load order is keyed
`P_k` (`P_0` = the compiler key, `P_k = Load.snoc(P_(k-1), step k)`), so any
entry whose load order starts the same way shares it. A build restores the
longest stored, *sealed* `P_k`, checks the rest in `book_over` children of it,
and stores a pack per sealed boundary.

## The one architectural rule (user constraint)

**All semantics live in Bend. TypeScript is only a capability host.**

TS may: read files, manage CAS bytes, drive the Bend checker (whose loader is
the only import parser), interpret the compiled Bend IO program. TS may
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
  in a later step than its declaration; `Verdict{todos, reliant}` is the
  checker's judgment of a final state; `CheckGroup`/`ResumeCandidate` are
  plans the host interprets; `OutputPath` is the emit target as the checker's
  CLI resolves it.
- `bend/App.bend` — everything that decides. `Build{entry, cache, compiler,
  mode}` with `Mode = Checking | Emitting{Emission{output, target}}`. The
  chain and its points; sealing (F5) and grouped check plans; the verdicts
  (PROOF.bend rule, TODO count, the report text, the output rule) with the
  checker's own texts; stability by comparing a second walk's observations;
  GC roots; the CLI (`check [--module]`, `build`, `cache status|verify|gc`).
  `check --module FILE` loads FILE as a sibling importer does (namespace
  `X` for `X.bend`), so checking modules bottom-up leaves exactly the
  prefixes their importers resume from; plain `check FILE` loads it as the
  entry (namespace `""`), a different state.

### Foreign boundary

- `foreign/host.js` — the only JS inside the compiled program: converts to and
  from Bend constructors and calls `globalThis.POC_HOST`. The checker's loader
  is async: `poc_await` returns a promise of the Result, which `src/cli.ts`'s IO
  loop awaits.
- `foreign/host.c` — a deliberate stub.

### TypeScript host

- `src/cli.ts` — loads `dist/app-lib.js`, runs the `$FFI` loop (awaiting
  promised capabilities).
- `src/host-preload.ts` — `POC_HOST`: private cache root; CAS
  `objects/<aa>/<key>/{meta.json,state.bin|artifact.bin}` with SHA-256 storage
  checksums (integrity only), metadata parsed at the boundary (schema 3, signed: a
  state's parent pack and its chain's foreign files; an artifact's report);
  quarantine on corruption; stages published parents first after Bend's
  stability check; GC roots and reachability GC.
- `src/compiler.ts` — drives the pinned checker in process: `loadSteps`
  (traversal-only walk; on a walk error, the cold load's error), `loadFills`
  (parse-only load; laws filled late, with their foreign/`@unsafe` flags),
  `check` (each group in a `book_over` child, later files skipped by `on` and
  forgotten, then `book_valid`), `verdict` (`book_owned`, TODO count, and the
  report, mirroring `cli_report` over summaries), `emit`, `emitRestored` (the
  replay: `book_valid(book, 0, only)` over what `main` reaches, closed under
  instance callers), and the checker's error rendering (`book_err`).
- `src/codec.ts` — packs (schema 3): a sealed boundary's own records without
  elaborations, with reference summaries; canonical; lazy restore through
  accessor properties; summaries readable without raising.
- `src/trust.ts` — statements, public key names, verification; key paths
  (`POC_SIGNING_KEY`, `POC_TRUSTED_KEYS`, default under
  `$XDG_CONFIG_HOME/bend-proof-of-compile/`).
- `src/signer.ts` — the signer: the only reader of the private key (`sign`,
  `public`, `trust KEY`); never loads the checker or program code.
- `src/build-bend-lib.ts` — builds `dist/app-lib.js`.

### Tests and tools

- `test/codec.test.ts` — golden vectors (`test/golden/`), decode∘encode = id on
  each pack, no stored elaborations, summaries agree, restored tables stay
  writable, malformed packs rejected (fixture `test/fixtures/pack/`).
- `test/sha.test.ts` — the patched SHA-224/256 against Node's.
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

## Verified behaviors

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
  bend `/nix/store/412w6jg0xmxppna1w41a38bm9zcpki4v-bend-2.0.25-unstable` (fork `80ffd6d1`),
  bun `/nix/store/9nmsidbfpjv43b5pzw0sbhpaz6mgc9v8-bun-1.4.2` (re-derive with
  `nix build` if inputs change).
- `warning: SQLite database '/nix/var/nix/db/db.sqlite' is busy` is harmless
  under concurrent nix builds.

## Commands

```sh
# Source of truth build + smoke test
nix build .#proof-of-compile

# Iterate on Bend source
$(nix build .#bend --print-out-paths)/bin/bend bend/App.bend --check-only

# Rebuild the compiled library used by the CLI
bun src/build-bend-lib.ts "$BEND2_SRC" bend/App.bend dist/app-lib.js

# Run the CLI directly
POC_APP_LIB=$PWD/dist/app-lib.js \
POC_BEND2_SOURCE="$BEND2_SRC" \
POC_HASHES_SOURCE=$(realpath vendor/bend-hashes) \
bun src/cli.ts check path/to/Main.bend
bun src/cli.ts check --module path/to/Lemmas1.bend   # as its importers load it
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
