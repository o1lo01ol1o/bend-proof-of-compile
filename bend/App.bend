import Base
import ./Host.bend as H
import ./Merkle.bend as M

# Compiler identity is derived in Bend from exact named bytes supplied by the
# host boundary. Both the compiler implementation and bend-hashes participate.
def App.inputs.go(
  +role: String,
  files: List<&2, H.NamedBytes>,
  digest: M.Digest
) -> M.Digest:
  match files:
    case Nil{}:
      digest
    case H.NamedBytes{path, bytes} <> rest:
      content = M.Key.file_bytes(bytes)
      item = M.Key.named_input(role, path, content)
      App.inputs.go(role, rest, M.Sequence.snoc(role, digest, item))

def App.inputs(+role: String, files: List<&2, H.NamedBytes>) -> M.Digest:
  App.inputs.go(role, files, M.Sequence.empty(role))

def App.compiler_key(inputs: H.CompilerInputs) -> M.Digest:
  match inputs:
    case H.CompilerInputs{compiler, hashes}:
      M.Key.compiler(
        App.inputs("compiler-files", compiler),
        App.inputs("bend-hashes-files", hashes)
      )

# What a build produces: the checker's verdict and report (`bend FILE
# --check-only`), or also an artifact (`bend FILE -o OUTPUT`).
type Emission is Data:
  Emission{output: String, target: String}

type Mode is Data:
  Checking{}
  Emitting{emission: Emission}

# One build's fixed context.
type Build is Data:
  Build{entry: String, cache: String, compiler: M.Digest, mode: Mode}

def App.entry(+build: Build) -> String:
  match build:
    case Build{entry, cache, compiler, mode}:
      entry

def App.cache(+build: Build) -> String:
  match build:
    case Build{entry, cache, compiler, mode}:
      cache

def App.compiler(+build: Build) -> M.Digest:
  match build:
    case Build{entry, cache, compiler, mode}:
      compiler

def App.mode(+build: Build) -> Mode:
  match build:
    case Build{entry, cache, compiler, mode}:
      mode

def App.output(+emission: Emission) -> String:
  match emission:
    case Emission{output, target}:
      output

def App.target(+emission: Emission) -> String:
  match emission:
    case Emission{output, target}:
      target

def App.order.imports(+order: H.LoadOrder) -> List<&2, H.LoadStep>:
  match order:
    case H.LoadOrder{imports, entry, rule}:
      imports

def App.order.entry(+order: H.LoadOrder) -> H.LoadStep:
  match order:
    case H.LoadOrder{imports, entry, rule}:
      entry

def App.order.rule(+order: H.LoadOrder) -> H.EntryRule:
  match order:
    case H.LoadOrder{imports, entry, rule}:
      rule

# Load-order chain
# ----------------
#
# P_0 is the compiler key and P_k = Load.snoc(P_(k-1), step k): the state
# keyed by P_k is the checker after the first k files of the load order.

def App.step.key(step: H.LoadStep) -> M.Digest:
  match step:
    case H.LoadStep{path, namespace, text}:
      M.Key.step(namespace, path, M.Key.file_text(text))

def App.step.path(+step: H.LoadStep) -> String:
  match step:
    case H.LoadStep{path, namespace, text}:
      path

def App.link(prefix: M.Digest, step: H.LoadStep) -> M.Digest:
  M.Load.snoc(prefix, App.step.key(step))

# The boundary after step `index` of the imports.
type Point is Data:
  Point{index: Nat, step: H.LoadStep, key: M.Digest}

def App.point.key(+point: Point) -> M.Digest:
  match point:
    case Point{index, step, key}:
      key

def App.point.index(+point: Point) -> Nat:
  match point:
    case Point{index, step, key}:
      index

def App.points.push(
  +compiler: M.Digest,
  +step: H.LoadStep,
  points: List<&2, Point>
) -> List<&2, Point>:
  match points:
    case Nil{}:
      Point{1n, step, App.link(compiler, step)} <> Nil{}
    case +last <> rest:
      Point{
        Nat.add(App.point.index(last), 1n),
        step,
        App.link(App.point.key(last), step)
      } <> last <> rest

# The import boundaries, latest first.
def App.points.go(
  +compiler: M.Digest,
  imports: List<&2, H.LoadStep>,
  points: List<&2, Point>
) -> List<&2, Point>:
  match imports:
    case Nil{}:
      points
    case step <> rest:
      App.points.go(compiler, rest, App.points.push(compiler, step, points))

def App.points(+compiler: M.Digest, imports: List<&2, H.LoadStep>) -> List<&2, Point>:
  App.points.go(compiler, imports, Nil{})

# P_n: the entry after every import.
def App.final(
  +compiler: M.Digest,
  latest: List<&2, Point>,
  entry: H.LoadStep
) -> M.Digest:
  match latest:
    case Nil{}:
      App.link(compiler, entry)
    case last <> rest:
      App.link(App.point.key(last), entry)

# Sealing
# -------
#
# Boundary k is sealed unless a law declared at or before k is filled after k
# by a foreign or @unsafe definition: a cold check parses the fill before it
# checks the law's declaration, and a state at k was checked without it. The
# final boundary always seals.

type Seal is Data:
  Sealed{}
  Unsealed{}

def App.fill.flagged(flags: List<&2, H.FillFlag>) -> Bool:
  match flags:
    case Nil{}:
      False{}
    case +unused_flag <> +unused_rest:
      True{}

def App.fill.crosses(+index: Nat, fill: H.LateFill) -> Bool:
  match fill:
    case H.LateFill{declared, filled, flags}:
      Bool.and(
        App.fill.flagged(flags),
        Bool.and(Nat.is_le(declared, index), Nat.is_lt(index, filled))
      )

def App.seal.both(crosses: Bool, rest: Seal) -> Seal:
  match crosses:
    case True{}:
      Unsealed{}
    case False{}:
      rest

def App.seal(+index: Nat, fills: List<&2, H.LateFill>) -> Seal:
  match fills:
    case Nil{}:
      Sealed{}
    case fill <> rest:
      App.seal.both(App.fill.crosses(index, fill), App.seal(index, rest))

# Check plans
# -----------

def App.group(steps: List<&2, H.LoadStep>, key: M.Digest) -> H.CheckGroup:
  H.CheckGroup{List.reverse(&2, H.LoadStep, steps), M.Digest.hex(key)}

def App.groups.at(
  +point: Point,
  +pending: List<&2, H.LoadStep>,
  seal: Seal
) -> Maybe<&2, H.CheckGroup>:
  match point seal:
    case Point{index, step, key} Sealed{}:
      Some{App.group(step <> pending, key)}
    case +unused_point Unsealed{}:
      None{}

def App.groups.pending(
  +point: Point,
  pending: List<&2, H.LoadStep>,
  seal: Seal
) -> List<&2, H.LoadStep>:
  match point seal:
    case +unused_point Sealed{}:
      Nil{}
    case Point{index, step, key} Unsealed{}:
      step <> pending

def App.groups.put(
  group: Maybe<&2, H.CheckGroup>,
  rest: List<&2, H.CheckGroup>
) -> List<&2, H.CheckGroup>:
  match group:
    case None{}:
      rest
    case Some{value}:
      value <> rest

# Splits the boundaries after a resumed state (earliest first) into groups
# that end at sealed boundaries; the last group ends at the entry.
def App.groups.go(
  points: List<&2, Point>,
  +pending: List<&2, H.LoadStep>,
  +entry: H.LoadStep,
  +final: M.Digest,
  +fills: List<&2, H.LateFill>
) -> List<&2, H.CheckGroup>:
  match points:
    case Nil{}:
      App.group(entry <> pending, final) <> Nil{}
    case +point <> rest:
      App.groups.put(
        App.groups.at(point, pending, App.seal(App.point.index(point), fills)),
        App.groups.go(
          rest,
          App.groups.pending(point, pending, App.seal(App.point.index(point), fills)),
          entry,
          final,
          fills
        )
      )

def App.groups(
  points: List<&2, Point>,
  +entry: H.LoadStep,
  +final: M.Digest,
  +fills: List<&2, H.LateFill>
) -> List<&2, H.CheckGroup>:
  App.groups.go(points, Nil{}, entry, final, fills)

def App.candidate.put(
  +point: Point,
  +after: List<&2, Point>,
  +entry: H.LoadStep,
  +final: M.Digest,
  +fills: List<&2, H.LateFill>,
  seal: Seal,
  rest: List<&2, H.ResumeCandidate>
) -> List<&2, H.ResumeCandidate>:
  match seal:
    case Sealed{}:
      H.ResumeCandidate{
        M.Digest.hex(App.point.key(point)),
        App.groups(after, entry, final, fills)
      } <> rest
    case Unsealed{}:
      rest

# The sealed import boundaries, latest first, each with the plan that
# finishes the check from it.
def App.candidates.go(
  latest: List<&2, Point>,
  +after: List<&2, Point>,
  +entry: H.LoadStep,
  +final: M.Digest,
  +fills: List<&2, H.LateFill>
) -> List<&2, H.ResumeCandidate>:
  match latest:
    case Nil{}:
      Nil{}
    case +point <> rest:
      App.candidate.put(
        point,
        after,
        entry,
        final,
        fills,
        App.seal(App.point.index(point), fills),
        App.candidates.go(rest, point <> after, entry, final, fills)
      )

def App.candidates(
  latest: List<&2, Point>,
  +entry: H.LoadStep,
  +final: M.Digest,
  +fills: List<&2, H.LateFill>
) -> List<&2, H.ResumeCandidate>:
  App.candidates.go(latest, Nil{}, entry, final, fills)

# Artifact keys
# -------------

def App.foreigns.go(files: List<&2, H.NamedBytes>, digest: M.Digest) -> M.Digest:
  match files:
    case Nil{}:
      digest
    case H.NamedBytes{path, bytes} <> rest:
      App.foreigns.go(
        rest,
        M.Sequence.snoc(
          "artifact-foreign-inputs",
          digest,
          M.Key.foreign(path, M.Key.file_bytes(bytes))
        )
      )

def App.artifact_key(
  +emission: Emission,
  +final: M.Digest,
  files: List<&2, H.NamedBytes>
) -> String:
  M.Digest.hex(M.Key.artifact(
    final,
    App.target(emission),
    App.foreigns.go(files, M.Sequence.empty("artifact-foreign-inputs"))
  ))

# Verdicts
# --------
#
# The checker's rejections that are not a check of the loaded records: the
# PROOF.bend rule and the count of holes and open laws of the final state.
# Their texts are the checker's own.

def App.loaded(+path: String, steps: List<&2, H.LoadStep>) -> Bool:
  match steps:
    case Nil{}:
      False{}
    case step <> rest:
      Bool.or(String.eq(path, App.step.path(step)), App.loaded(path, rest))

def App.rule.laws(loaded: Bool) -> Maybe<&2, String>:
  match loaded:
    case True{}:
      None{}
    case False{}:
      Some{"bend: PROOF.bend must import ./LAWS.bend (see bend --help)"}

def App.rule.at(rule: H.EntryRule, +steps: List<&2, H.LoadStep>) -> Maybe<&2, String>:
  match rule:
    case H.PlainEntry{}:
      None{}
    case H.ProofEntry{None{}}:
      None{}
    case H.ProofEntry{Some{laws}}:
      App.rule.laws(App.loaded(laws, steps))

def App.rule(+order: H.LoadOrder) -> Maybe<&2, String>:
  App.rule.at(App.order.rule(order), App.order.entry(order) <> App.order.imports(order))

def App.todos.plural(+todos: Nat, zero: Bool) -> Maybe<&2, String>:
  match zero:
    case True{}:
      None{}
    case False{}:
      Some{String.concat(
        "Error: "
          <> Nat.show(todos)
          <> Bool.pick(String, Nat.is_eq(todos, 1n), " TODO", " TODOs")
          <> " found.\nThe code is incomplete, and not a valid proof yet."
          <> Nil{}
      )}

def App.todos(+todos: Nat) -> Maybe<&2, String>:
  App.todos.plural(todos, Nat.is_eq(todos, 0n))

# The checker's report on an entry: `All terms check.`, or the entry's own
# claims that rely on @unsafe or foreign code (main.ts cli_report).
def App.report.lines(names: List<&2, String>) -> String:
  match names:
    case Nil{}:
      ""
    case name <> rest:
      String.concat("\n- " <> name <> App.report.lines(rest) <> Nil{})

def App.report.count(+count: Nat) -> String:
  String.concat(
    "All terms check, but "
      <> Nat.show(count)
      <> Bool.pick(String, Nat.is_eq(count, 1n), " def relies", " defs rely")
      <> " on unsafe or foreign code:"
      <> Nil{}
  )

def App.report(reliant: List<&2, String>) -> String:
  match reliant:
    case Nil{}:
      "All terms check."
    case +name <> +rest:
      String.append(
        App.report.count(List.length(&2, String, name <> rest)),
        App.report.lines(name <> rest)
      )

# Before an emit, the checker notes the report on stderr, and says nothing
# when no claim relies on a promise.
def App.note(reliant: List<&2, String>) -> IO(Unit):
  match reliant:
    case Nil{}:
      IO.pure(Unit, Unit{})
    case +name <> +rest:
      IO.print_err(App.report(name <> rest))

# The checker refuses to write over a file the program reads (a loaded file
# or a foreign file its records name), or a directory.
def App.named(+path: String, files: List<&2, H.NamedBytes>) -> Bool:
  match files:
    case Nil{}:
      False{}
    case H.NamedBytes{name, bytes} <> rest:
      Bool.or(String.eq(path, name), App.named(path, rest))

def App.output.refused(+output: String) -> Maybe<&2, String>:
  Some{String.concat(
    "bend: -o " <> output <> " is a file the program reads, or a directory (see bend --help)" <> Nil{}
  )}

def App.output.reads(+output: String, reads: Bool) -> Maybe<&2, String>:
  match reads:
    case True{}:
      App.output.refused(output)
    case False{}:
      None{}

def App.output.rule(
  +emission: Emission,
  +order: H.LoadOrder,
  +files: List<&2, H.NamedBytes>,
  path: H.OutputPath
) -> Maybe<&2, String>:
  match path:
    case H.OutputDirectory{real}:
      App.output.refused(App.output(emission))
    case H.OutputFile{+real}:
      App.output.reads(
        App.output(emission),
        Bool.or(
          App.loaded(real, App.order.entry(order) <> App.order.imports(order)),
          App.named(real, files)
        )
      )

# Stability: the load order, walked again after the work, must be the one
# the keys were computed from. The observations are compared directly (the
# same files, namespaces and texts, and the same PROOF.bend observation):
# equal observations fold to the same chain, and comparing costs a fraction
# of folding again.

# Text equality by tail calls, so a long file does not grow the stack.
def App.same.text(a: String, b: String, same: Bool) -> Bool:
  match a b:
    case SNil{} SNil{}:
      same
    case SNil{} SCon{+unused_head, +unused_tail}:
      False{}
    case SCon{+unused_head, +unused_tail} SNil{}:
      False{}
    case SCon{head_a, tail_a} SCon{head_b, tail_b}:
      App.same.text(tail_a, tail_b, Bool.and(same, Char.is_eq(head_a, head_b)))

def App.same.step(a: H.LoadStep, b: H.LoadStep) -> Bool:
  match a b:
    case H.LoadStep{path_a, namespace_a, text_a} H.LoadStep{path_b, namespace_b, text_b}:
      Bool.and(
        App.same.text(path_a, path_b, True{}),
        Bool.and(
          App.same.text(namespace_a, namespace_b, True{}),
          App.same.text(text_a, text_b, True{})
        )
      )

def App.same.steps(a: List<&2, H.LoadStep>, b: List<&2, H.LoadStep>, same: Bool) -> Bool:
  match a b:
    case Nil{} Nil{}:
      same
    case Nil{} +unused_head <> +unused_tail:
      False{}
    case +unused_head <> +unused_tail Nil{}:
      False{}
    case head_a <> tail_a head_b <> tail_b:
      App.same.steps(tail_a, tail_b, Bool.and(same, App.same.step(head_a, head_b)))

def App.same.laws(a: Maybe<&2, String>, b: Maybe<&2, String>) -> Bool:
  match a b:
    case None{} None{}:
      True{}
    case None{} Some{+unused_b}:
      False{}
    case Some{+unused_a} None{}:
      False{}
    case Some{laws_a} Some{laws_b}:
      App.same.text(laws_a, laws_b, True{})

def App.same.rule(a: H.EntryRule, b: H.EntryRule) -> Bool:
  match a b:
    case H.PlainEntry{} H.PlainEntry{}:
      True{}
    case H.PlainEntry{} H.ProofEntry{+unused_b}:
      False{}
    case H.ProofEntry{+unused_a} H.PlainEntry{}:
      False{}
    case H.ProofEntry{laws_a} H.ProofEntry{laws_b}:
      App.same.laws(laws_a, laws_b)

def App.stable.same(same: Bool) -> Maybe<&2, String>:
  match same:
    case True{}:
      None{}
    case False{}:
      Some{"source inputs changed during compilation"}

def App.same.order(a: H.LoadOrder, b: H.LoadOrder) -> Bool:
  match a b:
    case H.LoadOrder{imports_a, entry_a, rule_a} H.LoadOrder{imports_b, entry_b, rule_b}:
      Bool.and(
        App.same.steps(entry_a <> imports_a, entry_b <> imports_b, True{}),
        App.same.rule(rule_a, rule_b)
      )

def App.stable(
  +order: H.LoadOrder,
  walked: Result<&2, &2, String, H.LoadOrder>
) -> Maybe<&2, String>:
  match walked:
    case Fail{error}:
      Some{error}
    case Done{again}:
      App.stable.same(App.same.order(order, again))

# Effects
# -------

def App.purpose(mode: Mode) -> String:
  match mode:
    case Checking{}:
      "check"
    case Emitting{Emission{output, target}}:
      target

def App.root(+build: Build, +order: H.LoadOrder) -> String:
  M.Digest.hex(M.Key.root(
    App.step.path(App.order.entry(order)),
    App.purpose(App.mode(build))
  ))

# Records what this build keeps alive. Losing the record only lets GC reclaim
# more, so a failure to write it does not fail the build.
def App.keep(
  +build: Build,
  +order: H.LoadOrder,
  live: List<&2, String>
) -> IO(Unit):
  do IO<Unit>:
    kept : Result<&2, &2, String, Unit> <- H.Host.roots_put(App.cache(build), App.root(build, order), live)
    IO.pure(Unit, Unit{})

def App.fail(message: String) -> IO(Unit):
  IO.die(Unit, 1, message)

def App.success(message: String) -> IO(Unit):
  IO.print(message)

def App.stage.fail(stage: H.Stage, +message: String) -> IO(Unit):
  do IO<Unit>:
    H.Host.stage_abort(stage)
    App.fail(message)

def App.artifact_built(result: Result<&2, &2, String, Unit>) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{value}:
      App.success("built and cached artifact")

def App.emit.refused(
  +build: Build,
  +emission: Emission,
  +order: H.LoadOrder,
  +final: M.Digest,
  state: H.Checkpoint,
  +reliant: List<&2, String>,
  +artifact: String,
  refused: Maybe<&2, String>
) -> IO(Unit):
  match refused:
    case Some{error}:
      App.fail(error)
    case None{}:
      do IO<Unit>:
        App.keep(build, order, M.Digest.hex(final) <> artifact <> Nil{})
        result : Result<&2, &2, String, Unit> <- H.Host.artifact_build(
          App.cache(build),
          artifact,
          App.output(emission),
          App.target(emission),
          state,
          reliant
        )
        App.artifact_built(result)

def App.emit.output(
  +build: Build,
  +emission: Emission,
  +order: H.LoadOrder,
  +final: M.Digest,
  state: H.Checkpoint,
  +reliant: List<&2, String>,
  +files: List<&2, H.NamedBytes>,
  observed: Result<&2, &2, String, H.OutputPath>
) -> IO(Unit):
  match observed:
    case Fail{error}:
      App.fail(error)
    case Done{path}:
      App.emit.refused(
        build,
        emission,
        order,
        final,
        state,
        reliant,
        App.artifact_key(emission, final, files),
        App.output.rule(emission, order, files, path)
      )

def App.emit.foreigns(
  +build: Build,
  +emission: Emission,
  +order: H.LoadOrder,
  +final: M.Digest,
  state: H.Checkpoint,
  +reliant: List<&2, String>,
  found: Result<&2, &2, String, Maybe<&2, List<&2, H.NamedBytes>>>
) -> IO(Unit):
  match found:
    case Fail{error}:
      App.fail(error)
    case Done{None{}}:
      App.fail("the final checked state was not committed")
    case Done{Some{files}}:
      do IO<Unit>:
        observed : Result<&2, &2, String, H.OutputPath> <- H.Host.output_path(App.output(emission))
        App.emit.output(build, emission, order, final, state, reliant, files, observed)

def App.emit(
  +build: Build,
  +emission: Emission,
  +order: H.LoadOrder,
  +final: M.Digest,
  state: H.Checkpoint,
  +reliant: List<&2, String>
) -> IO(Unit):
  do IO<Unit>:
    App.note(reliant)
    found : Result<&2, &2, String, Maybe<&2, List<&2, H.NamedBytes>>> <- H.Host.state_foreigns(
      App.cache(build),
      M.Digest.hex(final)
    )
    App.emit.foreigns(build, emission, order, final, state, reliant, found)

def App.accepted(
  +build: Build,
  +order: H.LoadOrder,
  +final: M.Digest,
  state: H.Checkpoint,
  +reliant: List<&2, String>,
  mode: Mode
) -> IO(Unit):
  match mode:
    case Checking{}:
      IO.print(App.report(reliant))
    case Emitting{emission}:
      App.emit(build, emission, order, final, state, reliant)

def App.judged.todos(
  +build: Build,
  +order: H.LoadOrder,
  +final: M.Digest,
  state: H.Checkpoint,
  +reliant: List<&2, String>,
  rejected: Maybe<&2, String>
) -> IO(Unit):
  match rejected:
    case Some{error}:
      App.fail(error)
    case None{}:
      App.accepted(build, order, final, state, reliant, App.mode(build))

# A final state, stable (and committed), is judged as the checker judges an
# entry; an accepted state is reported, and emitted when asked.
def App.judged(
  +build: Build,
  +order: H.LoadOrder,
  +final: M.Digest,
  state: H.Checkpoint,
  verdict: H.Verdict
) -> IO(Unit):
  match verdict:
    case H.Verdict{+todos, reliant}:
      do IO<Unit>:
        App.keep(build, order, M.Digest.hex(final) <> Nil{})
        App.judged.todos(build, order, final, state, reliant, App.todos(todos))

# Newly checked states stay provisional until the load order is observed
# again, unchanged, so an input race cannot poison a content-addressed state.
def App.committed(
  +build: Build,
  +order: H.LoadOrder,
  +final: M.Digest,
  state: H.Checkpoint,
  verdict: H.Verdict,
  result: Result<&2, &2, String, Unit>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{value}:
      App.judged(build, order, final, state, verdict)

def App.checked.stable(
  +build: Build,
  +order: H.LoadOrder,
  +final: M.Digest,
  state: H.Checkpoint,
  stage: H.Stage,
  verdict: H.Verdict,
  unstable: Maybe<&2, String>
) -> IO(Unit):
  match unstable:
    case Some{error}:
      App.stage.fail(
        stage,
        String.append(error, "; no checkpoint or artifact was published")
      )
    case None{}:
      do IO<Unit>:
        result : Result<&2, &2, String, Unit> <- H.Host.stage_commit(stage)
        App.committed(build, order, final, state, verdict, result)

def App.checked(
  +build: Build,
  +order: H.LoadOrder,
  +final: M.Digest,
  result: Result<&2, &1, String, H.Checkpoint & H.Stage & H.Verdict>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{triple}:
      (state, stage, verdict) = triple
      do IO<Unit>:
        walked : Result<&2, &2, String, H.LoadOrder> <- H.Host.load_steps(App.entry(build))
        App.checked.stable(
          build,
          order,
          final,
          state,
          stage,
          verdict,
          App.stable(order, walked)
        )

def App.check(
  +build: Build,
  +order: H.LoadOrder,
  +final: M.Digest,
  groups: List<&2, H.CheckGroup>,
  seed: Maybe<&1, H.Checkpoint>,
  stage: H.Stage
) -> IO(Unit):
  do IO<Unit>:
    checked : Result<&2, &1, String, H.Checkpoint & H.Stage & H.Verdict> <- H.Host.book_check(
      App.cache(build),
      App.step.path(App.order.entry(order)),
      groups,
      seed,
      stage
    )
    App.checked(build, order, final, checked)

def App.resumed(
  +build: Build,
  +order: H.LoadOrder,
  +final: M.Digest,
  cold: List<&2, H.CheckGroup>,
  stage: H.Stage,
  result: Result<&2, &1, String, Maybe<&1, H.Checkpoint & List<&2, H.CheckGroup>>>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.stage.fail(stage, error)
    case Done{None{}}:
      App.check(build, order, final, cold, None{}, stage)
    case Done{Some{pair}}:
      (state, groups) = pair
      App.check(build, order, final, groups, Some{state}, stage)

def App.filled.rule(
  +build: Build,
  +order: H.LoadOrder,
  +latest: List<&2, Point>,
  +final: M.Digest,
  +fills: List<&2, H.LateFill>,
  stage: H.Stage,
  verdict: Maybe<&2, String>
) -> IO(Unit):
  match verdict:
    case Some{error}:
      App.stage.fail(stage, error)
    case None{}:
      do IO<Unit>:
        found : Result<&2, &1, String, Maybe<&1, H.Checkpoint & List<&2, H.CheckGroup>>> <- H.Host.state_get_longest(
          App.cache(build),
          App.candidates(latest, App.order.entry(order), final, fills)
        )
        App.resumed(
          build,
          order,
          final,
          App.groups(List.reverse(&2, Point, latest), App.order.entry(order), final, fills),
          stage,
          found
        )

# The checker parses every file before it applies the PROOF.bend rule, so a
# parse error is reported first, as in a cold check.
def App.filled(
  +build: Build,
  +order: H.LoadOrder,
  +latest: List<&2, Point>,
  +final: M.Digest,
  stage: H.Stage,
  result: Result<&2, &2, String, List<&2, H.LateFill>>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.stage.fail(stage, error)
    case Done{fills}:
      App.filled.rule(build, order, latest, final, fills, stage, App.rule(order))

def App.miss(
  +build: Build,
  +order: H.LoadOrder,
  +latest: List<&2, Point>,
  +final: M.Digest,
  started: Result<&2, &1, String, H.Stage>
) -> IO(Unit):
  match started:
    case Fail{error}:
      App.fail(error)
    case Done{stage}:
      do IO<Unit>:
        fills : Result<&2, &2, String, List<&2, H.LateFill>> <- H.Host.load_fills(
          App.step.path(App.order.entry(order)),
          List.append(&2, H.LoadStep, App.order.imports(order), App.order.entry(order) <> Nil{})
        )
        App.filled(build, order, latest, final, stage, fills)

def App.cold(
  +build: Build,
  +order: H.LoadOrder,
  +latest: List<&2, Point>,
  +final: M.Digest
) -> IO(Unit):
  do IO<Unit>:
    started : Result<&2, &1, String, H.Stage> <- H.Host.stage_start()
    App.miss(build, order, latest, final, started)

def App.state.rule(
  +build: Build,
  +order: H.LoadOrder,
  +final: M.Digest,
  state: H.Checkpoint,
  verdict: H.Verdict,
  rejected: Maybe<&2, String>
) -> IO(Unit):
  match rejected:
    case Some{error}:
      App.fail(error)
    case None{}:
      App.judged(build, order, final, state, verdict)

# A committed final state: stable, then judged. The state was checked from
# these exact files, so no parse error can precede the PROOF.bend rule.
def App.state.stable(
  +build: Build,
  +order: H.LoadOrder,
  +final: M.Digest,
  state: H.Checkpoint,
  verdict: H.Verdict,
  unstable: Maybe<&2, String>
) -> IO(Unit):
  match unstable:
    case Some{error}:
      App.fail(String.append(error, "; no artifact was published"))
    case None{}:
      App.state.rule(build, order, final, state, verdict, App.rule(order))

def App.state_found(
  +build: Build,
  +order: H.LoadOrder,
  +latest: List<&2, Point>,
  +final: M.Digest,
  result: Result<&2, &1, String, Maybe<&1, H.Checkpoint & H.Verdict>>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{None{}}:
      App.cold(build, order, latest, final)
    case Done{Some{pair}}:
      (state, verdict) = pair
      do IO<Unit>:
        walked : Result<&2, &2, String, H.LoadOrder> <- H.Host.load_steps(App.entry(build))
        App.state.stable(build, order, final, state, verdict, App.stable(order, walked))

def App.state_get(
  +build: Build,
  +order: H.LoadOrder,
  +latest: List<&2, Point>,
  +final: M.Digest
) -> IO(Unit):
  do IO<Unit>:
    found : Result<&2, &1, String, Maybe<&1, H.Checkpoint & H.Verdict>> <- H.Host.state_get(
      App.cache(build),
      M.Digest.hex(final)
    )
    App.state_found(build, order, latest, final, found)

# An artifact restored: stable, then the build's report is noted again.
def App.restored.stable(
  +output: String,
  reliant: List<&2, String>,
  unstable: Maybe<&2, String>
) -> IO(Unit):
  match unstable:
    case Some{error}:
      do IO<Unit>:
        H.Host.output_remove(output)
        App.fail(String.append(error, "; output was removed"))
    case None{}:
      do IO<Unit>:
        App.note(reliant)
        App.success("restored artifact from cache")

def App.artifact_restored(
  +build: Build,
  +emission: Emission,
  +order: H.LoadOrder,
  +latest: List<&2, Point>,
  +final: M.Digest,
  result: Result<&2, &2, String, Maybe<&2, List<&2, String>>>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{Some{reliant}}:
      do IO<Unit>:
        walked : Result<&2, &2, String, H.LoadOrder> <- H.Host.load_steps(App.entry(build))
        App.restored.stable(App.output(emission), reliant, App.stable(order, walked))
    case Done{None{}}:
      App.state_get(build, order, latest, final)

def App.final.refused(
  +build: Build,
  +emission: Emission,
  +order: H.LoadOrder,
  +latest: List<&2, Point>,
  +final: M.Digest,
  +artifact: String,
  refused: Maybe<&2, String>
) -> IO(Unit):
  match refused:
    case Some{error}:
      App.fail(error)
    case None{}:
      do IO<Unit>:
        App.keep(build, order, M.Digest.hex(final) <> artifact <> Nil{})
        restored : Result<&2, &2, String, Maybe<&2, List<&2, String>>> <- H.Host.artifact_restore(
          App.cache(build),
          artifact,
          App.output(emission)
        )
        App.artifact_restored(build, emission, order, latest, final, restored)

# A committed final state was checked from these exact files, so no parse
# error can precede the PROOF.bend rule or the output rule.
def App.final.rules(
  +build: Build,
  +emission: Emission,
  +order: H.LoadOrder,
  +latest: List<&2, Point>,
  +final: M.Digest,
  +files: List<&2, H.NamedBytes>,
  observed: Result<&2, &2, String, H.OutputPath>
) -> IO(Unit):
  match observed:
    case Fail{error}:
      App.fail(error)
    case Done{path}:
      App.final.refused(
        build,
        emission,
        order,
        latest,
        final,
        App.artifact_key(emission, final, files),
        Maybe.or(&2, String, App.rule(order), App.output.rule(emission, order, files, path))
      )

def App.final_found(
  +build: Build,
  +emission: Emission,
  +order: H.LoadOrder,
  +latest: List<&2, Point>,
  +final: M.Digest,
  found: Result<&2, &2, String, Maybe<&2, List<&2, H.NamedBytes>>>
) -> IO(Unit):
  match found:
    case Fail{error}:
      App.fail(error)
    case Done{None{}}:
      App.cold(build, order, latest, final)
    case Done{Some{files}}:
      do IO<Unit>:
        observed : Result<&2, &2, String, H.OutputPath> <- H.Host.output_path(App.output(emission))
        App.final.rules(build, emission, order, latest, final, files, observed)

# An emit looks for the artifact first; a check, for the final state.
def App.ordered(
  +build: Build,
  +order: H.LoadOrder,
  +latest: List<&2, Point>,
  +final: M.Digest,
  mode: Mode
) -> IO(Unit):
  match mode:
    case Checking{}:
      App.state_get(build, order, latest, final)
    case Emitting{emission}:
      do IO<Unit>:
        found : Result<&2, &2, String, Maybe<&2, List<&2, H.NamedBytes>>> <- H.Host.state_foreigns(
          App.cache(build),
          M.Digest.hex(final)
        )
        App.final_found(build, emission, order, latest, final, found)

def App.chained(+build: Build, +order: H.LoadOrder, +latest: List<&2, Point>) -> IO(Unit):
  App.ordered(
    build,
    order,
    latest,
    App.final(App.compiler(build), latest, App.order.entry(order)),
    App.mode(build)
  )

def App.walked(
  +build: Build,
  result: Result<&2, &2, String, H.LoadOrder>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{+order}:
      App.chained(build, order, App.points(App.compiler(build), App.order.imports(order)))

def App.compiler_ready(
  +entry: String,
  +cache: String,
  +mode: Mode,
  result: Result<&2, &2, String, H.CompilerInputs>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{inputs}:
      do IO<Unit>:
        order : Result<&2, &2, String, H.LoadOrder> <- H.Host.load_steps(entry)
        App.walked(Build{entry, cache, App.compiler_key(inputs), mode}, order)

def App.build(+entry: String, +cache: String, +mode: Mode) -> IO(Unit):
  do IO<Unit>:
    inputs : Result<&2, &2, String, H.CompilerInputs> <- H.Host.compiler_inputs()
    App.compiler_ready(entry, cache, mode, inputs)

# CLI
# ---

def Cli.report(result: Result<&2, &2, String, String>) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{report}:
      IO.print(report)

def Cli.status(cache: String) -> IO(Unit):
  do IO<Unit>:
    result : Result<&2, &2, String, String> <- H.Host.cache_status(cache)
    Cli.report(result)

def Cli.verify(cache: String) -> IO(Unit):
  do IO<Unit>:
    result : Result<&2, &2, String, String> <- H.Host.cache_verify(cache)
    Cli.report(result)

def Cli.gc.live(+cache: String, live: Result<&2, &2, String, List<&2, String>>) -> IO(Unit):
  match live:
    case Fail{error}:
      App.fail(error)
    case Done{keys}:
      do IO<Unit>:
        result : Result<&2, &2, String, String> <- H.Host.cache_gc(cache, keys)
        Cli.report(result)

# Retention policy: every recorded root is live; everything else is not.
def Cli.gc(+cache: String) -> IO(Unit):
  do IO<Unit>:
    live : Result<&2, &2, String, List<&2, String>> <- H.Host.roots_live(cache)
    Cli.gc.live(cache, live)

def Cli.build.options(
  args: List<&1, String>,
  +entry: String,
  +cache: String,
  +output: String,
  +target: String
) -> IO(Unit):
  match args:
    case Nil{}:
      App.build(entry, cache, Emitting{Emission{output, target}})
    case "--output" <> value <> rest:
      Cli.build.options(rest, entry, cache, value, target)
    case "--target" <> "js" <> rest:
      Cli.build.options(rest, entry, cache, output, "js")
    case "--target" <> "c" <> rest:
      Cli.build.options(rest, entry, cache, output, "c")
    case value <> rest:
      App.fail(String.append("unknown or incomplete build option: ", value))

def Cli.run(args: List<&1, String>, +cache: String) -> IO(Unit):
  match args:
    case "check" <> entry <> Nil{}:
      App.build(entry, cache, Checking{})
    case "build" <> entry <> rest:
      Cli.build.options(rest, entry, cache, "out.js", "js")
    case "cache" <> "status" <> Nil{}:
      Cli.status(cache)
    case "cache" <> "verify" <> Nil{}:
      Cli.verify(cache)
    case "cache" <> "gc" <> Nil{}:
      Cli.gc(cache)
    case _:
      App.fail(
        "usage: poc check ENTRY | poc build ENTRY [--target js|c] [--output FILE] | poc cache status|verify|gc"
      )

def Cli.cached(args: List<&1, String>, cache: Result<&2, &2, String, String>) -> IO(Unit):
  match cache:
    case Fail{error}:
      App.fail(error)
    case Done{root}:
      Cli.run(args, root)

def Cli.program(args: List<&1, String>) -> IO(Unit):
  do IO<Unit>:
    cache : Result<&2, &2, String, String> <- H.Host.cache_root("bend-proof-of-compile", "v3")
    Cli.cached(args, cache)

def main() -> IO(Unit):
  do IO<Unit>:
    args : List<&1, String> <- IO.args()
    Cli.program(args)
