# Spec: persistent module artifacts (bendlang/bend#2055) with minimal fork burden

> **Design record, 2026-11-07 to 2026-11-08**, committed 2026-11-10. Its status
> and progress tables are as of 2026-11-08. For the current state (the fork's
> `main` at `poc/2.0.40+poc.3`, poc and bend-categories tracking `main`, pack
> schema 8) read `HANDOFF.md`.

Status: **proposal, 2026-11-07.** Decisions D1–D5 are open; everything else is
measured. The probe script and the measurement logs are in this session's
scratchpad (`probe/probe-e.ts`); the numbers below come from them.

## The question

Issue #2055 asks Bend for module-scoped intermediate representations emitted
before whole-program optimization, so that unchanged modules are neither
checked nor lowered again and the final build combines reachable artifacts
into one C file. This document answers: can we have that on our side, and
what does it cost to keep as upstream moves?

Short answer: yes, and the cheapest way is **not the fork**. Upstream has
settled on a pattern for exactly this kind of tool (a cache outside `bend`
that patches `bend2` as Bun loads it), the one capability the pattern lacks
for builds (storing elaborations) turns out to need no kernel change, and a
probe on unmodified upstream 2.0.40 compiles byte-identical C and JS from
stored elaborations on every book it could build.

## Where upstream is, and where the fork is

| | fork (pinned) | upstream `main` |
|---|---|---|
| Revision | `1ee1ac90`, Bend 2.0.27 + 11 commits | `be236f32`, Bend 2.0.40 (2026-11-05) |
| Distance | base `5108d040` | 447 commits past the base, 13 releases |
| Our kernel delta | 578 lines: `bend.ts` 257, `comp.ts` 35, `main.ts` 97, tests | — |
| Upstream churn in those files since the base | — | `bend.ts` 1,480 lines changed, `comp.ts` 7,361 (rewritten), `main.ts` 682 |
| Rebased since | the published pin, never; a local, unpublished triad (`~/Work/bend-triad-7a7e6505`, 2026-10-28) rebased the series onto 2.0.39 and migrated poc and bend-categories to it (see `PLAN-upstream-bump.md`); downstream repos still pin 2.0.27 | — |

Upstream's position is explicit:

- **PR #1010** (our resumable-checked-books API, 2026-09-24) was closed:
  "Bend's core is kept small on purpose … we only take extensions for
  outside use when they add no complexity for normal Bend use, and this one
  adds a lot." `bend.ts` is human-written; `gates/repo.ts` caps `bend.ts` at
  48k tokens, `comp.ts` 66k, `main.ts` 16k, and only Taelin changes a cap.
- **PR #1631** (an opt-in check cache in the CLI) was closed: "We don't want a
  check cache inside the CLI itself. We're planning a separate tool for
  incremental checking … caching will live there."
- **PR #1846** (`--trust`, file-level skipping) was closed in favour of
  **#2045 `tools/bend-cache`** (merged 2026-11-04). Its close carries the
  comparison that matters for us (ms, median of 5):

  | | plain | prefix keys | file/import keys | traces (#2045) |
  |---|---|---|---|---|
  | #1234 client after another client | 739 | 50 | — | 67 |
  | #1234 library edited | 728 | **758** | — | **66** |
  | slash_boss + one proof added | 2,821 | 3,160 | — | 160 |
  | false passes (125 books, 1,044 edits) | | 0 | **6** | 0 |

  "Prefix keys" is our model (`P_k` over the load order): it gains nothing
  when a library file changes, because everything after it in the load order
  is re-checked, which `HANDOFF.md` also records ("an edit before the
  expensive file costs a cold `poc` check"). File-plus-imports keys (the
  `.olean` way, and what "module artifacts" naively means) are unsound in
  Bend: a law's fill is visible in load order, not along imports. Upstream
  also notes that no file in their 1,719-file corpus reads a fill it does not
  import, so import-scoped fills (our #2032 is in that direction) would make
  module granularity sound later.

### What bend-cache is

`tools/bend-cache/src/cache.ts` (363 lines) runs `bend --check-only` with a
proof cache, byte-for-byte the CLI's output. It loads `bend2`'s own sources
through a `Bun.plugin` `onLoad` hook and applies **five anchored text edits**
(three in `bend.ts`: `book_valid` takes a skip predicate and counts TODOs for
skipped entries; two in `main.ts`: validation goes through a hook, the
promise walk reads the names kept for skipped defs). Each edit must match
exactly once or the tool exits 2 ("drift"); it also exits if `Book` gains a
field. While a def is checked, Proxies on `book.tlds`, `book.ctrs` and
`book.tmps` (the only state the checker reads) record the first read of each
name and hash what it found (lowered terms, spans dropped; Base by name). A
later run skips a def at its own event when every read hashes the same. The
order of events, including whether a law was still opaque, is part of what a
read finds, so no visibility rule is modelled.

Maintenance record so far: nine commits touched `bend.ts`/`main.ts` in the
two days since it merged, including the 2.0.40 release and a checker change
("equal share cells join a class"); the anchors held and it runs at today's
HEAD (checked here: 536 defs checked cold, 13 skipped warm on
`tests/proof/LAWS.bend`).

Its stated limit is our problem statement: "Only `--check-only`: a run or a
build needs each def's elaborated body, which a skipped check does not make."

## Finding: elaborations are storable without a kernel change

`SPEC-incremental-compilation.md` rejected storing elaborations (F1) because
`Def.e` holds closures (87,121 on the heavy benchmark) and an
empty-environment raise turns checker levels into global references. On
2.0.40 the shape is:

- `Def.e` is an `LTerm`. Every checked node is wrapped by the checker as
  `Ann(x, Var("_", -1, v: ty))` (`Infer`/`Check` in `bend.ts`), and share
  cells are `Var(k, -1, v)`. `ty` and the cells' values are live `HTerm`s,
  which is where the closures are.
- `term_higher` returns a `Var` with `i < 0` **unchanged**, so the compiler
  reads those cells as they are.
- Probe over 46 corpus books: every closure in every body is reachable only
  through a `Var.v` cell (`closNoV = 0`), and no body carries a let-bound
  value cell (`posV = 0`).

So a codec can, with the kernel's own exported functions only:

1. **Encode** a body as a DAG (one id per shared node, spans as a file index
   plus offsets). At each cell, lower its value with `Bend.term_lower(v, d)`
   where `d` is the depth of the enclosing binders, read off the `LTerm`
   itself (`Lam.i`, `All.i`, `Let.i[]`, `Sub.i`, which are the checker's
   levels).
2. **Decode** by rebuilding the DAG and raising each cell's lowered value
   with `Bend.term_higher(low, env)` where `env` binds every enclosing level
   `i` to `Var(k_i, i)`. Free checker levels stay variables, which is what
   the checker's own cells hold; F1 does not arise.

Result on unmodified upstream 2.0.40 (`compile_book` and `js_book`, before
and after replacing every `Def.e` by its decoded encoding):

| Books | Outcome |
|---|---|
| 24 `tests/compile`, 4 `tests/import`, 4 `tests/io`, 4 `demos/*/main.bend` | C and JS **byte-identical** (36 of 36) |
| `tests/io/bundle_inline.bend` | JS identical; its C build is refused cold as well |
| 8 books without `main` or without `import Base` | nothing to compare |

| Book | bodies | nodes | closures | encoded (JSON / gzip) | encode | decode + raise | cold check |
|---|---|---|---|---|---|---|---|
| a Base-only program (`float_trig`) | 373 | 64,816 | 5,696 | 6.1 MB / 0.6 MB | 76 ms | 44 ms | 69 ms |
| `demos/app_ray_tracer_3d` | 406 | 94,005 | 8,534 | 8.2 MB / 0.8 MB | 89 ms | 46 ms | 130 ms |
| `demos/app_slash_boss_3d` | 839 | 284,807 | 30,336 | 25 MB / 2.6 MB | 288 ms | 145 ms | 722 ms |
| bend-categories `Setoids_Unsafe.bend` | 424 | 72,824 | 6,671 | 13 MB / 1.4 MB | 150 ms | 71 ms | 73 ms (no `main`: sizes only) |

Caveats, all engineering rather than feasibility:

- The sizes are a naive upper bound: each cell's type is lowered and stored
  on its own, so one type object shared by many cells is written once but
  structurally equal types are not deduplicated (about 60 bytes per node).
  A content-hashed type table would cut this several-fold; Base's 370 bodies
  need not be stored at all (bend-cache re-checks Base every run, ~20 ms).
- The codec *calls* `term_lower` and `term_higher`; it does not mirror them.
  Both changed semantics once in the 447 commits (`term_higher` now returns
  a `Var`'s substitution; `term_lower` keeps a `Var`'s fields). A change
  there shows up as a failed byte-equality test, not as silent divergence.
- Lowering a type without a cache is exponential on typed let chains (the
  fork's `low` cache fixed that in `term_lower`). The probe memoizes by
  (object, depth) outside the kernel; a chain inside one type would still
  cost. Measure on the private workload before committing to no kernel
  patch for this; if needed it is one anchored edit, the fork's own.

## The artifact, as built on the triad route (2026-11-08)

The intermediate compile object is the **checked state of a module together
with the complete elaboration of every definition in it**, stored at check
time as one pack per sealed boundary (`bend-proof-of-compile`, pack schema 6).
Nothing is skipped and nothing is re-elaborated at build time: a build
restores the packs its entry reaches and hands the assembled book to the
compiler as it is. The replay path and its kernel support (`prepare_book`,
`book_valid(…, only)`) are gone from poc.

**What the elaboration is, and what it is not.** The compiler's input for a
definition is `Def.e`: the checked body with the checker's type cell on every
node. The compiler reads it through one call (`term_higher` in comp.ts
`fun_of`) and reads types at the nodes it chooses; it never reads a span and
it keys types span-free (`ty_key`, `term_same` via the kernel's `term_key`).
So the artifact is the elaboration *as data up to spans*: decode∘encode is
the identity up to spans and up to the kernel's raise (which reduces a redex
it builds), and the law that holds exactly is the emitted program.

**Why it had to be content-addressed and span-free.** Measured on the
heaviest bend-categories module, `Interchange/Braided_Unsafe.bend` (1,020
bodies, check 3.4–5 s):

| Representation of the module's elaborations | nodes |
|---|---|
| As the checker holds them (objects by identity, closures unopened) | 22 M objects + 1.5 M closures, 5 GB |
| Written out as trees (every cell's type lowered) | 84 M |
| Distinct by content, with spans | 26 M (bodies 9.7 M, types 16.3 M) |
| **Distinct by content, without spans** | **484 K** (bodies 141 K, types 344 K); 23.5 MB JSON |

The checker builds structurally equal types over and over and shares them
only through closures, and every copy carries the spans of wherever its
pieces came from; spans alone defeat deduplication 50-fold. One table per
pack therefore stores each node once by its own wire text, and a cell is
(name, level, id of its value lowered at the cell's binder depth). Restored
cells are raised under an environment binding each enclosing level to its
variable, so free checker levels stay variables (the F1 defect never
arises).

**Cost, and the trade-off it leaves.** Encoding is linear in the written-out
size, not the stored size, because the kernel's lowering re-opens every
closure: on that module 36 s (3.5 s of it the kernel's lowering, the rest the
table's hashing of 84 M nodes), with no memory above the check's own peak;
decoding the whole module takes 0.8 s. On applications it is negligible
(`app_slash_boss_3d`: 0.36 s against a 0.24 s check; 83 K nodes, 3.8 MB).
So a proof-heavy module pays roughly ten times its check time once per
content, in exchange for the artifact being a function of the module alone.
The alternatives, not taken: deferring each definition's elaboration object
to the first build that needs it (zero check-time cost, but a second object
kind and the replay kept); or a fork change tagging the kernel's raise
closures with their (term, environment) so types serialize without being
opened (estimated several-fold faster encoding, one more kernel divergence).

**What the compiler-side cost is not.** Per-definition C or JS text is not
the artifact: comp.ts emits each definition's segments under a whole-program
fixpoint of ownership facts (`c_units`), exactly the whole-program
optimization #2055 says the per-module IR precedes.

## Nix composition (D7, 2026-11-08): one derivation per sealed boundary

**What the store is today.** poc's store is a content-addressed directory
(`objects/<2 hex>/<64 hex>/{meta.json, state.bin|artifact.bin}`, `roots/`,
`quarantine/`) under `$TMPDIR/bend-proof-of-compile/v4`; every object's
metadata is signed by the local Ed25519 signer and verified against the
trusted keys in `$XDG_CONFIG_HOME` on read. In a Nix sandbox `$TMPDIR` is the
build directory, so every build starts cold; bend-tauri-poly's
`POC_CAS_ROOT` is not read by poc at all.

**What a state's key depends on.** `P_k = snoc(P_(k-1), Key.step(namespace,
realpath, content))` from `P_0` = the compiler. The loader gives an imported
file the namespace `relative(entry directory, realpath)` without `.bend`, or
`0x<pkg>/…` for a BendHub package under `BEND_LIB`; the names in the checked
book carry that namespace. Two consequences fix the design:

1. **Vendoring by relative path makes artifacts entry-relative.** The same
   library module imported from two entries in different directories has two
   namespaces, so two different checked books and two different keys. This is
   also the 2.0.40 failure on the application: a vendored symlink into the
   Nix store resolves to a relative namespace through a store segment that may
   start with a digit, which the loader's name rule refuses. **Hub packages
   have entry-independent namespaces** (`0x<pkg>/path`) and realpaths under
   one `BEND_LIB` kit, so a library consumed as a hub package has the same
   names and the same keys from every importer built against that kit. That
   is the form a composable Bend dependency takes.
2. **Keys are prefixes of the entry's load order.** A dependency's standalone
   chain is a prefix of an importer's order only when it is the importer's
   first import (after Base). The second dependency continues a new chain.
   So joined stores are always *sound* to compose (a key hit is a true hit)
   but *useful* along load-order prefixes only: a derivation DAG that follows
   the application's own load order, each boundary seeded by the one before
   it, gets full reuse across rebuilds (a change to file k rebuilds k‥n) and
   reuse across applications on common prefixes. Order-independent reuse
   per module needs module-scoped keys (states keyed by a module's import
   closure), which is sound only under import-scoped law fills, the
   discipline upstream's #2032 points at. That is a checker-level design
   decision, out of this scope and recorded as D8.

**The design.**

- **poc: layered stores** (built 2026-11-08). `POC_STORE` names the writable
  store (default as today); `POC_STORE_PATH` names read-only stores searched
  after it, so a `symlinkJoin` of derivation outputs is one read-only layer.
  Writes, GC, verification and quarantine act on the writable store only; a
  read-only object that fails verification is a miss with a debug line. (A
  `symlinkJoin` of `objects/` trees composes by construction because keys are
  unique.) Since keys name files by real path, the producing and the
  consuming build must read the sources at the same real path: in Nix, the
  source's store path, which both derivations take as the same input.
- **poc: trust for store layers** (D9, decided: provenance, built
  2026-11-08). A read-only layer is trusted as a build input; its objects
  are read whatever key signed them, and a signature that does not verify
  is a miss. The writable store keeps signatures against trusted keys.
- **flake library** (built 2026-11-08: `nix/composition.nix`, exposed as
  `lib.composition { pkgs, poc }`, checked by the flake check `composition`).
  `chain { name, kit, regions, layers }` makes one derivation per region of
  a load order: each checks a synthetic entry importing the hub modules of
  every region up to its own (`import Base`, then `import 0x<pkg>/M.bend as
  M_i` in order), reads the regions before it as layers, and writes its
  region's objects to its output; a region seals states under
  `--allow-unsafe`, since the verdict belongs to an entry. `store` is the
  `symlinkJoin` of layers; `build { name, src, entry, layers, kit, target }`
  runs `poc build` against the layers and emits the artifact. The check
  shows an application resuming from the chain (only its entry checked) and
  emitting `bend -o`'s bytes. The load order is **materialized**: a committed
  file generated by `poc plan [--module] FILE` (built 2026-11-08: one step
  per line, `namespace<TAB>realpath`, Base first, the entry last) and checked
  for drift in CI (as bend-categories' `checks/corpus.order` already is),
  never computed at evaluation time (no import-from-derivation).

  Granularity, stated plainly: a state's key names each file by real path,
  and a hub package's namespace embeds the package's content hash, so the
  unit of Nix-level reuse is the dependency *package* at a pin. An edit
  inside a package changes every path and name in it and re-checks that
  package's chain (and everything after it in the load order); packages
  before it in the order are untouched. Module-level reuse within a package
  would need path-independent keys and packs (D10, not started): keys from
  namespace and content only, with the loader's `seen` paths and foreign
  paths stored relative to a root and re-based on restore.
- **Dependencies as hub packages.** A library enters an application through
  the kit, not through a vendored relative symlink; the application's flake
  composes kits with `symlinkJoin` as bend-poly-org's kit already does.

**Costs stated.** Reuse is along prefixes (above). A proof-heavy library's
boundary derivations pay the elaboration cost once per content (D6). Hub
packaging changes how bend-categories and bend-poly are imported by
applications (D011 rehosting becomes unnecessary; relative vendoring goes).

## Design: artifacts = bend-cache's traces + stored elaborations

Per build, on an unmodified `bend2` (upstream release, pinned by hash):

1. **Load everything** with the kernel's loader, unchanged. Parsing is the
   fixed cost of this design. Upstream measured a 386-file, 9.2 MB, 31.3k-def
   application loading in 8.1 s as written and 1.0 s after rewriting its
   string-literal patterns (issue #2038); our 50-file heavy benchmark is
   under a second.
2. **Validate with bend-cache's skip predicate.** At each entry whose trace
   matches, instead of checking: install its stored body (decoded) on the
   record, and replay the writes its check made, namely the template
   instances it minted (their records with their own bodies, and the
   `tmps` entries), in the order it minted them, so later numbering is the
   cold one. An entry whose trace misses is checked as cold; its trace, body
   and minted instances are written to the store.
3. **Compile the assembled book** with `compile_book` / `js_book` / `js_lib`
   as today. Whole-program optimization is untouched, as #2055 accepts. The
   C or JS artifact is content-addressed by the set of (def, trace hash)
   pairs plus target, so a no-op build is a lookup.

Mapped onto #2055's words: a module's artifact is its defs' traces, bodies
and minted instances; its "interface" is the parsed type, which is always
re-parsed (cheap and exact); "implementation information for template
expansion" is the minted instances; "the final build combines reachable
module artifacts" is step 3 over the assembled book.

Why per-def with load order rather than per-module by imports: see the
table above (6 false passes). If upstream scopes fills by imports, the same
store serves module granularity with a coarser trace.

What this replaces in `bend-proof-of-compile`:

| Today (fork + poc) | Proposed |
|---|---|
| `book_over`, `book_flat`, `on` hook, `book_valid(done, only)` replay: 257 fork lines in `bend.ts` | bend-cache's 3 anchored edits in `bend.ts`, maintained upstream |
| Prefix chain `P_k` in `Merkle.bend`/`App.bend`; `--module` bottom-up checking | per-def traces; no prefix, no module role (an entry and an import of the same file hash their records the same way bend-cache does) |
| Re-elaboration of what `main` reaches on every build after a restore | bodies restored; zero re-elaboration |
| Sealing rule for late foreign/unsafe fills (F5) | not needed: a fill's flags are part of what a read of the law finds |
| CAS store, Ed25519 signing, GC roots, quarantine (`host-preload.ts`, `trust.ts`, `signer.ts`) | **kept**; the store holds traces and bodies instead of packs |
| `codec.ts` packs (types and bodies, no elaborations) | a body codec (the probe), plus traces |

Costs: SHA-256 of each read's lowered JSON per run (memoized per record;
bend-cache measured cold +15–30% on benches of thousands of cheap defs and
keeps a trace only for checks over 0.2 ms); a full parse per run; Base
re-checked per run; the store grows with bodies (gzip ~10×).

## Maintenance burden, compared

| Strategy | Kernel lines we own | Per upstream release | Risk |
|---|---|---|---|
| A. Keep the fork, rebase | 578 across three files, one rewritten | re-apply onto ~35 commits/week of churn; `comp.ts` conflicts certain | design upstream rejected; never converges; downstream repos stay pinned |
| B. Stay pinned at 2.0.27 | 578, frozen | none | no upstream fixes (2.0.40 turned a 900 s check into 3.3 s; memory fixes); hub packages move on |
| **C. Patch seam + codec** | **0** (5 anchored edits upstream owns; our codec calls exports) | re-pin, run the byte-equality suite; drift exits 2 | kernel representation change breaks the codec visibly; fix is local |
| D. C, then upstream the build extension into `tools/bend-cache` | 0 | nothing beyond C while the tool lives upstream | acceptance is upstream's call; `gates/repo.ts` lists tool files one by one |

## Migrating off 2.0.27 (prerequisite for C and D)

Measured on bend-categories at `b01fe7c`:

| Entry | fork 1ee1ac90 | upstream 2.0.40 |
|---|---|---|
| `tests/Smoke.bend` | `All terms check.` | `ALL PROOFS CHECK`, 0.08 s |
| `tests/Modules.bend` | `All terms check, but 19 defs rely on unsafe…`, exit 0, 0.7 s | checks, then `SOME PROOFS FAIL: 320 defs rely on unsafe or foreign code`, exit 1, 0.8 s |
| `…/Restriction/Down_Unsafe.bend` (797 KB), as an entry | rejected: unknown constructor `../../../../Category/Core.MkCategory` (the 2.0.27 route-named namespaces that bend-categories' D011 rehosting works around) | checks in 19.5 s, 1.09 GB (2.0.28 names files by real path, #1042); verdict fails on 558 reliant defs |
| `…/Instance/Setoids_Unsafe.bend` (heavy benchmark root) | 0.07 s, 85 MB (6 reliant defs noted) | 0.08 s, 89 MB (verdict fails on 14) |
| `bench/spans-pentagon-lemmas/Lemmas1.bend` | **0.59 s real, 1.32 s user, 417 MB** | **2.23 s real, 3.38 s user, 749 MB** (verdict fails on 35) |

Two things change for us, neither in the checker:

- **Verdict policy.** Since 2.0.3x the CLI's verdict ranges over every
  non-Base def in the loaded book: if any imported def relies on `@unsafe` or
  foreign code, `--check-only` exits 1 with `SOME PROOFS FAIL`, adding a hint
  when none of the entry's own claims use one. 2.0.27's report (and poc's
  `reliant()` today) judged the entry's own defs plus filled laws, printed a
  note and exited 0. Our library is `_Unsafe` by design, so nearly every
  entry fails the stock verdict on 2.0.40 while checking itself passes, and
  the certification claim bend-categories' D006 makes (own claims clean) is
  no longer something the stock CLI states. The tool prints its own verdict
  (as bend-cache does through `cli_verdict`), so this is a policy choice
  (D4), not a blocker.
- **Base names.** New Base names can collide with ours (#1913 `Tool` hit
  another user); none seen in the three entries above.
- **Namespaces.** Since 2.0.28 a file's names are keyed by its real path
  (#1042), so a `src/` module checks as its own entry; the fork needed
  bend-categories' D011 rehosting for that. See `PLAN-upstream-bump.md`.
- **Checker speed.** The fork's last commit (`1ee1ac90`, bounded positive
  alpha-congruence) is a conversion speedup for exactly our proof shapes, and
  it is not upstream: `Lemmas1.bend` checks 2.6× slower and in 1.8× the
  memory on 2.0.40. It is a self-contained perf change of the kind upstream
  merges weekly (`perf(check)` PRs by outside contributors in 2.0.40 alone),
  so it should go upstream as its own PR, decoupled from any caching API;
  until it lands, the cache saves the re-checks but a cold check costs more.

## Decisions

- **D1 Strategy.** Decided 2026-11-07, Inbox: **finish the triad** (the
  local fork-rebase workspace at 2.0.39; `PLAN-upstream-bump.md`), that is
  Alternative A carried to `v2.0.40`. This spec recommended C (patch seam +
  codec); its codec finding is kept as the stored-bodies increment on the
  fork route. D2–D5 below are settled by that choice as the plan records.
- **D2 "All semantics live in Bend."** Under C the invalidation judgment is
  "every read of this def hashes the same", computed in TypeScript over
  kernel data, as bend-cache does. Keeping the rule literally would mean
  hashing MBs of lowered terms per run in pure Bend at ~1.6 MB/s (the
  streaming SHA-256), seconds to minutes per build. Recommended: restate the
  rule as "the kernel decides what a check depends on (its own reads); the
  host only hashes"; this removes the second import parser and the sealing
  rule the current design still carries in Bend.
- **D3 Home.** Start in this repo as a vendored copy of bend-cache's seam
  plus the codec, with upstream's `tools/bend-cache` tests as the oracle;
  propose the build extension upstream once it passes our acceptance.
- **D4 Verdict on 2.0.40.** Reproduce the 2.0.27 note-and-exit-0 behaviour
  in our tool, or adopt upstream's failure and restructure per its hint.
  Recommended: reproduce 2.0.27's behaviour behind a flag, default to
  upstream's.
- **D5 Instance names.** Restore minted instances in order (byte-identical
  to `bend -o`), or patch `def_inst` to content-keyed names (#1633's
  one-liner) so artifacts compose regardless of order, at the cost of `-o`
  output that differs from stock in instance names. Recommended: restore in
  order; revisit if upstream adopts #1633.

- **D6 When the elaboration is produced.** Decided 2026-11-08, Inbox: **(A)
  at check time, as built**, refined the same evening: *beside* the state,
  not inside it. Restoring bend-categories' 1,091-link chain parsed every
  elaboration for a 6-second resume and held 14.9 GB; a pack is now two
  payloads under one key and one signature (pack schema 7, CAS schema 5),
  and a check never reads the elaboration, a build reads one pack's on the
  first body it compiles from it. Measured, the elaboration was a tenth of
  the parsed restore; the records' lowered types and values were the rest
  (one module's 55-pack chain: 260 MB of term JSON, 24 MB compressed, 1.7 GB
  resident after a parse that raised nothing), so pack schema 8 stores each
  record's terms as one compressed blob inflated on the record's first read.
  The options were: (A) at check time, in the module's pack, as
  built: the artifact is a function of the module; a proof-heavy module pays
  ~10× its check once per content. (B) deferred: the checked state at check
  time, each definition's elaboration object at the first build that needs
  it; zero check-time cost, a second object kind, the replay kept. (A') (A)
  plus a fork change tagging the kernel's raise closures with (term,
  environment), so types serialize unopened; estimated several-fold faster
  encoding, one more kernel divergence. A' stays available if the corpus
  total proves too costly.
- **D7 How artifacts survive Nix builds.** Decided 2026-11-08, Inbox: **one
  derivation per sealed boundary, composed in the flake**, over a persistent
  cache outside the sandbox. The person adds: reusable Nix infrastructure
  that composes many Bend dependencies this way through `symlinkJoin`. Design
  and limits: "Nix composition" above.
- **D8 Module-scoped keys.** Decided 2026-11-08, Inbox: **not now; prefix
  reuse first and measure.** States keyed by a module's import closure
  instead of the entry's load-order prefix would compose dependencies
  order-independently; sound only under import-scoped law fills (upstream
  #2032's direction). A checker-level change.
- **D9 Trust for Nix store layers.** Decided 2026-11-08, Inbox:
  **provenance.** A read-only layer is a build input whose integrity its
  builder guarantees, so its objects are read whatever key signed them (a
  signature that does not verify is still a miss); the writable store keeps
  signatures against the reader's trusted keys.
- **D10 Path-independent keys and packs** (open): states keyed by namespace
  and content only, paths re-based on restore, so an edit inside a package
  re-checks only the edited module's suffix of the chain rather than the
  whole package. Needed for module-level reuse under Nix; not started.

## Milestones

1. **Pin upstream 2.0.40** (`flake.nix` `bend-src`), keep `bend-hashes`;
   port `test/acceptance.test.ts`'s oracle (`bend --check-only`, `bend -o`)
   and `tools/cold-equivalence.ts` to it. Record the verdict policy delta.
2. **Body codec** from the probe as `src/body-codec.ts`: DAG encoding, file
   table, depth-aware cell lowering, raise under the binder environment,
   deduplicated type table; tests: byte-identical C and JS over the fork's
   corpus and the demos (the probe's harness, run as a test).
3. **Seam**: vendor bend-cache's patch table and loader (or import it from
   a pinned upstream checkout); extend the skip path to install bodies and
   replay minted instances; traces and bodies into the existing CAS with
   signatures; `poc check` through it.
4. **Builds**: `poc build` compiles the assembled book; artifact key from
   the trace set; GC roots as today.
5. **Acceptance** on bend-categories: cold, warm no-op, library edit deep in
   the load order, entry edit; against the oracle; peak RSS; store size.
6. **Upstream**: propose the body codec and the skip-time restore as a
   `tools/bend-cache` extension (its README names builds as the open gap).
