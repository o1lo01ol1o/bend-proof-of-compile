# Plan: bump the Bend fork to upstream and propagate through poc and bend-categories

> **Design record, 2026-11-07 to 2026-11-08**, committed 2026-11-10. Its status
> and progress tables are as of 2026-11-08. For the current state (the fork's
> `main` at `poc/2.0.40+poc.3`, poc and bend-categories tracking `main`, pack
> schema 8) read `HANDOFF.md`.

Status: **decided route, 2026-11-07.** The strategy question (track upstream) was
settled by the request for this plan; the route question was answered in the
Inbox the same day: **finish the triad** (the fork-rebase workspace described
below), not the patch-seam pivot of `SPEC-persistent-artifacts.md`. That answer
also settles the spec's other open questions, as the Decisions section says.

## Progress (2026-11-08)

| Step | State | Evidence |
|---|---|---|
| Phase 1, fork | **done, published** | `o1lo01ol1o/bend` `poc/2.0.40` = `5158ac74`, tag `poc/2.0.40+poc.1`; `main` fast-forwarded to `v2.0.40`; triad heads kept as `archive/*` tags. Series: 13 commits (checkpoint dropped, one `main.ts` hunk resolved, five fixtures re-expected to 2.0.40's text, `own` field, `BUILD = "+poc.1"`, `comp.ts` cap 66,600). Upstream `tests/`: 1,852 of 1,852 files identical to plain `v2.0.40` under `--check-only`; repo gate 56/56; the five pre-existing type errors only. |
| Speedup | **kept** | `Lemmas1.bend` 0.85 s / 368 MB on the fork vs 3.91 s / 677 MB on `v2.0.40`; `HorizontalIndex.bend` 90 s / 1.8 GB vs over 900 s. |
| Phase 2, poc | **done, published** | `o1lo01ol1o/bend-proof-of-compile` `bend-2.0.40` (`18dee39e`, handoff `d714950`): pins the published fork, no `bend-categories` input, version derived; pack schema 5 with stored bodies, `Ctr.f` kept (fixes a crash rendering type errors over a restored prefix), no replay. `nix build .#proof-of-compile` passes: 35 tests and the install check. |
| Phase 3.1–3.3, bend-categories | **done, published** | GitLab `main` = `ed9296e` (fast-forward from `b01fe7c`): the triad's month of work, `bend-src.follows = "bend-poc/bend-src"`, gate on the 2.0.40 verdict, D012. Bounded gate checks `bend-cli` and `bend-categories` pass. |
| Phase 2, artifact | **done, published; refined** | poc `bend-2.0.40` = `bda4290` (Nix gate green, 37 tests): pack schema 6; refined the same evening to schema 7 (elaboration stored beside the state as a second payload, CAS schema 5, cache v5) after a 1,091-link resume held 14.9 GB: one span-free content-addressed term table per pack (`src/term-table.ts`), every valued definition's elaboration stored, replay removed. Worst bend-categories module: 484 K nodes / 23.5 MB where spans made it 26 M; encode 36 s against a 3.5–5 s check; `app_slash_boss_3d` 0.36 s. bend-categories re-pinned to it; the corpus rerun follows; the Inbox holds the open decision D6 (produce at check time, deferred to first build, or a fork change tagging raise closures). |
| D7, Nix composition | **library built** | poc (pushed to `bend-2.0.40`): layered stores (`POC_STORE`, `POC_STORE_PATH`, provenance trust per D9), `poc plan [--module] FILE`, and `lib.composition` (`chain`/`store`/`build`, `nix/composition.nix`) with the flake check `composition` green. Next: a real consumer (an application taking a dependency as a hub kit). Was: poc's flake `lib.bendBoundaries` / `lib.bendStore` / `lib.bendBuild`; trust for layers waits on D9 (Inbox). Design and limits: `SPEC-persistent-artifacts.md`, "Nix composition". |
| Phase 3.4–3.6 | **rerunning (resumed at link 1092)** | the schema-6 run reached link 1091 of 1122 in 5,073 CPU-s (faster than the budget run on every common batch, though that run shared the machine with measurements), then one module exceeded the 580 CPU-s single-module cap; by the user's decision (bend-categories D013, `b332658`) the cap is a batching budget, not a gate: `--single-cap 7200`, resumed on the same cache. Earlier: | the first corpus run (budget version, superseded) reached W1008 in 6,434 CPU-s with batchcheck's own over-cap splits; it reruns on the schema-6 poc once bend-categories is re-pinned. |
| Not done | | old fork branches left in place (downstream flakes pin commits on them); bend-categories' `proof-tooling` check fails on tests that read gitignored `checks/corpus/` evidence, before and after this work. |

## What the system is, and what changes

Three repositories form one toolchain. The **fork** (`o1lo01ol1o/bend`) is the
compiler; its `main` is upstream 2.0.27 (`5108d040`) and its pinned branch
adds eleven commits: ten for the checked-book API that `poc` consumes, one a
conversion speedup. **poc** (`bend-proof-of-compile`) is the incremental
checker and builder; it pins the fork by revision and reaches its API through
`Bend.book_load(…, on)`, `book_valid(…, only)`, `Main.book_over`,
`Main.book_flat`. **bend-categories** pins the same fork revision and a poc
revision, drives poc through check chains (`tools/checkchain.py`,
`tools/batchcheck.py`, `tools/capcheck.sh --module`), and reads the compiler's
verdict text in its gates. Four more repositories pin poc the same way
(bend-poly, bend-diagrams, bend-functor-…, bend-vm); they are out of scope here
and listed at the end.

After the bump: the fork's `main` is upstream's release commit, and one
series branch above it, `poc/2.0.40`, carries the checked-book API, the
Promise scheduler, the report policy and the conversion speedup, rebased onto
each release; poc runs on that fork, as it does today, and stores checked
bodies so builds no longer re-elaborate; bend-categories follows poc's compiler
pin, so the system has exactly one compiler revision, and its gates read the
2.0.40 verdict through poc. Every step below is forced by a Nix check.

## In-flight work: the triad at 2.0.39 (verified 2026-11-07)

A coordinated bump already exists, locally and unpublished:
`~/Work/bend-triad-7a7e6505/`, created 2026-10-28, last touched 2026-11-01,
holding four worktrees on `triad/7a7e6505/*` branches of the fork, poc,
bend-categories and bend-wasm-loop. Its frozen upstream target is `7a7e6505`
(Bend 2.0.39, 2026-10-27). None of its branches is on GitHub or GitLab; its
README says publishing or replacing its machine-local pins needs approval.

| Repository | Branch head | What it holds | Uncommitted on top |
|---|---|---|---|
| fork | `1b8140bf` | 9 of the 11 checked-book commits re-applied on 2.0.39, then one commit adding a Promise-capable JS scheduler (`comp.ts` +74: async `io_run`, Promise effects park continuations) and `book_report` with `BookPolicy = "proof" \| "allow-unsafe"` and a `--allow-unsafe` CLI flag (`main.ts` +134) | the alpha-congruence speedup re-applied (`bend.ts` +45, three tests) and `Comp.prepare_book` (`comp.ts` +10) |
| poc | `8fcafb5` | runs on Bend's generated executable (`dist/app.js`) with that scheduler instead of its own `$FFI` loop; schema-4 packs; reports delegate to Bend's `book_report`; `poc check --allow-unsafe`; flake pins `git+file:///…/bend-triad-7a7e6505/bend?rev=1b8140bf`; Nix build and install check passed, 27 tests pass | adapter requires `prepare_book`; codec and acceptance edits (+111) |
| bend-categories | `f4eb08f` | pins both by `git+file`; its snapshot commit carries 1,128 files and 103k lines of unpublished work (137 new modules, `verification/QuotientOrigins`, tools, evidence) that GitLab `main` (`b01fe7c`, 2026-10-01) lacks | 45 files (+942/−172) |
| validation | `validation/`, 1,171 files | a corpus chain run on this toolchain accepted 1,256 of 1,787 links; one link (`W1282`, the CupCap declaration) took 607 s and 24.7 GB; the per-module gate tooling was not migrated | |

Facts that bear on the plan:

- **Distance.** `v2.0.40` is 82 commits past `7a7e6505`, 51 of them touching
  the three kernel files. Trial-rebasing the triad's ten commits onto
  `v2.0.40`: nine apply cleanly; the scheduler-and-report commit conflicts in
  one `main.ts` hunk. The uncommitted kernel edits apply cleanly.
- **The fork's carried surface would triple.** Today's pin carries 578
  lines; the triad carries about 800 across all three kernel files, including
  a JS scheduler upstream did not write (upstream's `io_run` is still
  synchronous at `v2.0.40`). Under the seam strategy, a Bend-side program
  that needs asynchronous capabilities has two homes left: this fork
  scheduler, or poc's old `$FFI` loop that the triad deleted. That is the
  concrete cost of "all semantics live in Bend" (D2) on upstream.
- **The triad settled the verdict policy in the fork.** `--allow-unsafe`
  prints `ALL TERMS CHECK` with an explicit assumption list and exits 0,
  while `book_promises` still ranges over the whole book. The seam design
  gives the same behaviour from poc with no fork change; the `BookReport`
  shape and its tests carry over.
- **bend-categories' real base is the triad branch, not `main`.** The main
  checkout at `~/Work/bend-categories` has 494 dirty paths, every one older
  than and contained in the triad's snapshot, and the triad worktree adds 45
  more. Nothing in this plan's Phase 3 should be done against GitLab `main`.
- **The heavy modules are checker cost, not cache cost.** `W1282` at 607 s
  and 24.7 GB on the prefix chain is one module's own check; no reuse
  strategy changes it. It is the shape the alpha-congruence commit targets
  and belongs in Phase 0's measurements beside `HorizontalIndex.bend`.

Decision (Inbox, 2026-11-07): **finish the triad.** The triad is the base of
every phase below. Its runtime migration, `BookReport` policy, schema-4 codec
and validation harness are kept; its `git+file` pins become published
revisions; its series is rebased onto `v2.0.40` and carried per release.

Measured cost of the carry, against upstream's permanent caps (`ttok`,
`gpt-3.5-turbo` counts, as `gates/repo.ts` does):

| File | cap | upstream `main` | triad series delta | on `v2.0.40` with the series |
|---|---|---|---|---|
| `bend.ts` | 48,000 | 45,867 | +1,129 | 46,996 (fits, 1,004 spare) |
| `comp.ts` | 66,000 | 65,977 | +570 | **66,547 (over by ~550)** |
| `main.ts` | 16,000 | 13,036 | +1,004 | 14,040 (fits) |

The scheduler commit is what puts `comp.ts` over; upstream itself sits 23
tokens under that cap and sheds tokens to stay there. The fork therefore
carries either a compaction of upstream's `comp.ts` by at least 550 tokens
(many lines, conflicting on every upstream `comp.ts` change) or a one-line
raise of its own cap in `gates/repo.ts` (what `1ee1ac90` did). Phase 1 takes
the cap line: it is the smaller carry and rebases trivially, at the cost of
the fork no longer passing upstream's gate as written. It is stated here as a
trade-off, not hidden.

## Design authorities

- **Reuse model:** Mokhov, Mitchell and Peyton Jones, *Build Systems à la
  Carte*. The current prefix chain is correct but not minimal; import-keyed
  modules are minimal but incorrect in Bend; verifying traces over the
  checker's actual reads are both, and storing bodies makes them constructive
  traces. Upstream's own measurements (PR #1846's close) agree.
- **Carrying patches:** Kroah-Hartman's documented position on out-of-tree
  code: the cost of a carried series grows with every release. The decision
  to carry the triad's series is yours; the plan keeps the series as small as
  the design allows (the replay commit goes once bodies are stored), rebases
  it on release commits only, and upstreams what upstream will take (the
  speedup; a Promise-effects proposal as an issue).
- **Pins and checks:** the correct-by-construction Nix directives. One pin per
  fact, propagated by `follows`; everything supported is forced in `checks`;
  the fork is pinned by a release-based revision, never a moving branch; no
  version literal restates what the pinned source says.
- **The stored body:** King's parse-don't-validate. The wire form is its own
  type, the parse is total, and the round-trip law is witnessed by
  byte-identical emitted programs.

## Measured ground (before anything moves)

| Fact | Measurement |
|---|---|
| Upstream distance | 447 commits, 13 releases; `bend.ts` 1,480 lines changed, `comp.ts` 7,361, `main.ts` 682 |
| Release to pin | `v2.0.40` = `624dd9f4` (2026-11-05); includes `tools/bend-cache` (#2045) |
| Fork `main` → upstream | fast-forward (`5108d040` is an ancestor of `624dd9f4`) |
| The speedup commit `1ee1ac90` on `v2.0.40` | one conflict hunk in `bend.ts` (lines 3192–3217, the share-cell class change) and the cap line in `gates/repo.ts` |
| Speedup still needed | `Lemmas1.bend`: fork 0.59 s / 417 MB, upstream 2.23 s / 749 MB |
| bend-cache against an external `bend2` | works; `Lemmas1.bend` cold 3.0 s, warm 0.21 s (55 defs skipped at the 0.2 ms trace threshold) |
| Verdict text on 2.0.40 | clean: `ALL PROOFS CHECK`, exit 0; reliant: `SOME PROOFS FAIL` + `Error: N defs rely on unsafe or foreign code`, exit 1 |
| bend-categories modules by verdict class | 1,134 under `src/`: 992 `_Unsafe`, 32 safe modules importing a companion, 110 importing none |
| Entry-mode checking of `src/` modules | upstream 2.0.28 keys names `ns:name` by real path (#1042); `src/…/Core_Unsafe.bend` checks as an entry on 2.0.40 where the fork rejects it (`the alias Core shadows Core.Category`), the case D011's rehosting works around |
| Stored bodies | byte-identical C and JS on 36/36 buildable books (`SPEC-persistent-artifacts.md`) |

Compatibility sweep of the 142 non-`_Unsafe` modules checked as entries on
both compilers:

| Compiler | `ALL PROOFS CHECK` / `All terms check.` (exit 0) | verdict fails on `@unsafe` reliance (exit 1) | rejected as an entry (exit 1, `Error:`) | total wall, 4 parallel |
|---|---|---|---|---|
| upstream 2.0.40 | 108 | 2 | 0 | 25 s |
| fork 1ee1ac90 | 90 | 0 | 20 | 20 s |

Two findings fall out of the sweep.

- **D011's rehosting is no longer needed on 2.0.40 for this set.** The 20
  entry-mode rejections on the fork are all the route-naming artifact D011
  describes (`Cartesian.bend`, `Slice.bend`, `Functor/Properties.bend`, …);
  every one of them checks as its own entry on 2.0.40. The remaining 1,024
  modules (the `_Unsafe` companions and the 32 that import one) are
  confirmed in Phase 0's corpus run, not here.
- **The 2.0.40 verdict ranges over the loaded book, not the entry's claims.**
  `Category/Complete/Finitely.bend` and
  `NaturalTransformation/NaturalIsomorphism.bend` import no `_Unsafe`
  companion directly, and the fork reports the second as `All terms check.`
  (the first it rejects as an entry). On 2.0.40 both fail with 84 and 111
  reliant defs, every one of them in an imported module reached through
  `Cartesian.bend` or `Morphism.bend`, and the CLI's own hint says so: "no
  law or proof uses these defs". The cause is in `main.ts`: `book_promises`
  now takes `own` to be every non-Base def in `book.order`, where the fork's
  `cli_report` took the entry's own defs plus filled laws. So D006's
  property, that a module's own claims rely on nothing contracted, still
  holds for both modules; the stock CLI no longer states it, and from
  2.0.28 (#1001) it also walks fills wherever they land. Phase 3 keeps
  D006's meaning by having poc print the verdict over the entry's own claims
  (its `reliant()` already does), which is D4's second half, and records the
  change in D012.

The module that stalled the unbounded sweep, `Bicategory/Construction/
Monoidal/HorizontalIndex.bend`, imports two `_Unsafe` companions and so is
outside the 110. Capped at 240 s as an entry: the fork rejects it after 8.9 s
(the same route-naming artifact), and 2.0.40 does not finish. Whether that is
a 2.0.40 conversion cost the fork's speedup would have removed, or a module
that was always minutes long and only ever checked through the chain, is
Phase 0's first question; it is the shape the carried commit exists for.

## Propagation order and the one-pin invariant

```
upstream v2.0.40 ──ff──▶ fork main
                  └──rebase──▶ fork poc/2.0.40 (the triad's series, rebased per release)
                                      │ pinned by revision in
                                      ▼
                              poc flake: inputs.bend-src
                                      │ follows
                                      ▼
                   bend-categories flake: bend-src.follows = "bend-poc/bend-src"
```

Invariant: the compiler revision is written in one place, poc's `flake.nix`.
bend-categories cannot bump the compiler without bumping poc, which is the
coupling we want: a poc revision certifies its compiler API use against that
fork revision.
Today the arrow points the other way (bend-categories owns `bend-src` and poc
follows it) and poc's own `bend-categories` input is pointed at a non-flake
source to break the cycle; both go. Lock updates are their own commits.

## Phase 1: the fork (2–3 days)

Work happens in the triad worktree `~/Work/bend-triad-7a7e6505/bend` on
`triad/7a7e6505/integration`; the original checkout at `~/Work/bend` is not
touched until the push.

1. **Commit the pending edits** as two commits on the series: the
   alpha-congruence re-application with its three `tests/check/congruence_*`
   files, and `Comp.prepare_book`. Both apply cleanly to `v2.0.40` already.
2. **Rebase the series onto `v2.0.40`** (`git rebase --onto 624dd9f4
   7a7e6505`). Nine commits apply cleanly. The scheduler-and-report commit
   conflicts in `book_promises`: upstream's `c2d6f7fd` replaced the `roots`
   array with `unsafe` and `foreign` arrays and returns early when both are
   empty; the triad's version parameterizes the same walk by a `read`
   accessor so restored records never raise. Resolution: upstream's shape
   (two arrays, early return) with the triad's `read` parameter threaded
   through, and the `BookPolicy` filter after it. The 2.0.40 release also
   added the `BUILD` tag (`75b9e278`), which the series uses in step 4.
3. **Hold the caps.** Raise `comp.ts`'s cap in the fork's `gates/repo.ts` to
   66,600 with a comment naming the series; leave the other caps. Run
   `uvx ttok -m gpt-3.5-turbo` over the three files and `bun gates/repo.ts`
   (it needs `ttok` on `PATH`).
4. **Name the build.** `const BUILD = "+poc.1"` in `main.ts`, so `bend
   version` prints `bend 2.0.40+poc.1`; the suffix increments with every
   fork revision on the same upstream version.
5. **Run upstream's tests locally**: the fork's `tests/snapshot/*` fixtures,
   `tests/check`, `tests/proof` and `tests/import` through `bend FILE
   --check-only` (the cluster gate `gates/test.ts` does not run here), and
   bend-categories `tests/Smoke.bend`, `tests/Modules.bend`,
   `Lemmas1.bend` and a chain wrapper for `HorizontalIndex.bend` under the
   cap, on `v2.0.40` plain and on the rebased series. The last two are the
   speedup's benches.
6. **Publish.** Rename the rebased branch `poc/2.0.40`, push it to
   `o1lo01ol1o/bend`, tag `poc/2.0.40+poc.1`; fast-forward `main` to
   upstream `v2.0.40`; tag the `triad/7a7e6505/*`, `expose-book-state-api`,
   `resumable-checked-books` and `perf/bounded-alpha-congruence` heads as
   `archive/*` and delete the branches. Drop the committed
   `PLAN-persistent-checked-books.md` and the `AGENTS.md` edit from the
   series (they are history, kept under the archive tags).
7. **Per-release procedure**, written into the fork's README: for upstream
   release `vX`, `git rebase --onto vX <previous upstream> poc/<previous>`
   as `poc/X`; expect conflicts where conversion (`bend.ts`), the verdict
   (`main.ts`) and `io_run` (`comp.ts`) move; re-run steps 3 to 5; bump
   `BUILD`; re-pin poc. Budget hours per release; the series is about 820
   lines plus the cap line.

Trade-off stated: the fork no longer passes upstream's `gates/repo.ts` as
written, and the scheduler cannot go upstream in this form. The speedup can
(Phase 5); a Promise-effects proposal goes upstream as an issue, and if
upstream adopts one the scheduler commit is dropped from the series.

## Phase 2: poc on the published fork (1–2 weeks)

Base: the triad poc worktree on `triad/7a7e6505/integration` (`8fcafb5`) with
its pending edits committed. The prefix architecture, `--module`, the
checked-book API and the Bend-side program stay; the triad already moved that
program onto the fork's scheduler, which is the resolution of the spec's D2.

1. **Flake boundary.** `bend-src` → `github:o1lo01ol1o/bend/<poc/2.0.40
   rev>` (no `git+file`); remove the `bend-categories` input and the
   `checks.bend-categories` re-export (the cycle's other half; bend-categories
   will follow poc's pin instead); derive the version from the pinned source
   (`builtins.match` over `bend2/main.ts`'s `VERSION` and `BUILD`) instead of
   the `bendVersion` literal; `checkScript`'s API smoke asserts the fork
   surface poc uses (`book_load(…, on)`, `book_valid(…, only)`, `book_over`,
   `book_flat`, `book_report`, `prepare_book`). Lock update as its own commit.
2. **Stored bodies (the #2055 increment).** The probe's codec enters
   `src/codec.ts` as pack schema 5: each record keeps its checked body as a
   DAG whose cells hold types lowered at binder depth, raised at restore under
   the environment of the enclosing levels, with a content-keyed table of
   lowered types; template instances are already stored per pack in minting
   order, which is the spec's D5. `emitRestored` compiles the restored book
   directly; the replay, `prepare_book` and `book_valid(…, only)` become
   unused and the two corresponding commits leave the fork series at the next
   rebase, shrinking the carry. Golden vectors for schema 5; the probe's
   harness as `test/body-codec.test.ts` (byte-identical `compile_book` and
   `js_book` over the fork's corpus and demos).
3. **Verdict.** `book_report` with `BookPolicy` is the report (the spec's D4,
   as the triad built it: strict by default, `--allow-unsafe` behind a flag).
   One addition to the carried series: `BookReport`'s `Fail` carries `own:
   boolean`, the fact the message's hint already encodes (none of the
   entry's own defs or laws is reliant), so bend-categories' D006 claim is
   read from a field, not from text.
4. **Tests and checks.** The triad's acceptance and runtime tests, the
   body-codec test, and `tools/cold-equivalence.ts` as the black-box oracle;
   `checks.acceptance`, `checks.body-codec` and the install check in the
   flake, so `nix flake check` is the gate and the package is the artifact.
5. **Docs.** `HANDOFF.md` is rewritten from the triad's version;
   `SPEC-incremental-compilation.md` moves to `docs/history/` with
   `SPEC-persistent-artifacts.md`, whose seam route was not taken but whose
   codec finding is item 2.

Trade-offs stated: builds still parse and restore through the prefix chain,
so a library edit early in the load order still re-checks everything after
it (the model bend-categories' proof-layout rules already account for); the
stored bodies add about 60 bytes per node before deduplication.

## Phase 3: bend-categories (1 week, plus corpus wall time)

Base: the triad worktree on `triad/7a7e6505/integration` (`f4eb08f`) with its
45 pending files. GitLab `main` is a month behind it.

1. **Publish the base.** Commit the pending files, push the branch, and
   merge it to `main` on GitLab before any pin moves, so the propagation has
   a published base and the month of work is off one machine.
2. **Flake boundary.** `bend-poc` → the Phase 2 revision on GitHub;
   `bend-src.follows = "bend-poc/bend-src"`, deleting this repository's own
   compiler URL; `bendVersion` derived as in Phase 2; `checks.bend-cli` reads
   the derived version. One pin, one lock commit.
3. **Gate semantics for the 2.0.40 verdict.** The stock CLI's verdict ranges
   over the whole loaded book, so `test "$(bend X | tail -n 1)" = "All terms
   check."` holds only for the 108 companion-free modules whose closure
   reaches no companion. The gates read the verdict through poc instead:
   strict mode's exit code, `--allow-unsafe`'s assumption list, and the
   `own` field for D006's claim (a module's own claims rely on nothing
   contracted). `checkall.sh`'s string match and the `BEND_FULL_CHECK` lane
   are rewritten to that; negative fixtures keep their exit-code checks.
4. **D011 under 2.0.28's namespaces.** The sweep shows all 110 companion-free
   modules check as their own entries on 2.0.40 (the fork rejects 20). When
   the corpus run confirms it for every module, D011 is superseded (D012)
   and `tools/rehost.awk` and `checks/each/` go.
5. **Check chains stay.** The prefix model is kept with the fork, so
   `checkchain.py`, `batchcheck.py`, `capcheck.sh --module`, the wrappers and
   `checks/corpus.order` are unchanged; only the evidence tools that read
   verdict text follow item 3. The compiler key changes with the pin, so the
   corpus is cold again: the triad's journal (1,256 of 1,787 links accepted)
   is the baseline the new run is compared against, and the `W1282` CupCap
   link (607 s, 24.7 GB) is the first thing to re-measure with the speedup.
6. **Docs.** `docs/PROOF-ENGINEERING.md` keeps its model (an edit costs its
   file and every later file) and gains the 2.0.40 verdict semantics;
   `docs/DECISIONS.md` gains D012: compiler promoted to `2.0.40+poc.1`, the
   whole-book verdict and how D006 is now read, D011's status, the two
   companion-free modules the stock verdict fails.

## Phase 4: other downstreams (out of scope, listed)

bend-poly and bend-diagrams pin fork `d169f62d` and poc `6fc8719`;
bend-functor-… pins fork `1ee1ac90` and poc `53efee17`; bend-vm pins poc
`6fc8719`. Each follows bend-categories' recipe: `bend-src` follows
`bend-poc/bend-src`, gates read the 2.0.40 verdict, `--module` callers
become module checks.

## Phase 5: upstream (in parallel from Phase 1)

1. The speedup as a `perf(check)` PR with `bench/checker/congruence_24` and
   its three tests, against `main`, inside the caps.
2. An issue proposing Promise effects in the JS scheduler, with the triad's
   `io_run` as the reference; if upstream adopts a form of it, the scheduler
   commit leaves the series.
3. Optionally, the body codec as a `tools/bend-cache` build extension; it
   needs no fork and is independent of this route.

## Acceptance

- `bend version` on the published fork prints `bend 2.0.40+poc.1`; the fork's
  `tests/snapshot/*` and the sampled upstream `tests/` pass; `bun
  gates/repo.ts` passes with the fork's caps.
- `nix flake check` passes from a clean checkout in all three repositories at
  the new pins, with poc's `acceptance`, `body-codec` and install checks and
  bend-categories' rewritten `bend-categories` and `proof-corpus` checks; no
  `git+file` input remains anywhere.
- `bend -o` artifacts for `tests/Smoke.bend` and `tests/Modules.bend` are
  byte-identical between poc (restored bodies, no replay) and the fork's CLI.
- The corpus chain checks cold on `2.0.40+poc.1` with a journal; the `W1282`
  link is re-measured; a warm no-op over the chain is seconds.
- `nix flake metadata` shows one `bend-src` node reached through `follows`
  from every repository.

## Decisions

- **Route: finish the triad** (Inbox, 2026-11-07).
- The spec's D2 (where invalidation is computed) is settled by the route: the
  Bend-side program stays, on the fork's scheduler. D3 (home): this
  repository. D4 (verdict): `book_report` with `--allow-unsafe`, as the triad
  built it, plus the `own` field. D5 (instance names): restored in minting
  order from the packs.
- **Taken here, stated as a trade-off:** the `comp.ts` cap is raised in the
  fork's `gates/repo.ts` rather than paid by compaction.

Phases 1 and 3.1 can start now; Phase 2 waits on the published fork revision,
Phase 3.2 onward on the published poc revision.
