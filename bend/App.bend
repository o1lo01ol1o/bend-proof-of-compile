import Base
import ./Graph.bend as G
import ./Host.bend as H
import ./Merkle.bend as M
import ./Source.bend as S

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

# Entry checkpoint and artifact keys are pure folds over the checked graph.
def App.prefix.go(edges: List<&2, G.ImportEdge>, prefix: M.Digest) -> M.Digest:
  match edges:
    case Nil{}:
      prefix
    case edge <> rest:
      App.prefix.go(rest, M.Key.prefix_step(prefix, G.Graph.edge.digest(edge)))

def App.prefix.start(+compiler: M.Digest, +graph: G.Graph) -> M.Digest:
  M.Key.prefix_start(compiler, G.Graph.node.path(G.Graph.root(graph)))

def App.prefix.final(+compiler: M.Digest, +graph: G.Graph) -> M.Digest:
  App.prefix.go(
    G.Graph.node.imports(G.Graph.root(graph)),
    App.prefix.start(compiler, graph)
  )

def App.state_key(+compiler: M.Digest, +graph: G.Graph) -> M.Digest:
  M.Key.entry_state(
    compiler,
    G.Graph.node.key(G.Graph.root(graph)),
    App.prefix.final(compiler, graph)
  )

def App.artifact_key(
  +compiler: M.Digest,
  +graph: G.Graph,
  +target: String
) -> M.Digest:
  M.Key.artifact(App.state_key(compiler, graph), target)

# The namespace used by Bend's loader for a direct import is the normalized
# POSIX specifier without its .bend suffix. This normalization lives here,
# beside dependency semantics, rather than in the capability host.
def App.path.parent.relative(
  +head: String,
  +tail: List<&2, String>,
  is_parent: Bool
) -> List<&2, String>:
  match is_parent:
    case True{}:
      ".." <> head <> tail
    case False{}:
      tail

def App.path.parent(
  stack: List<&2, String>,
  rooted: Bool
) -> List<&2, String>:
  match stack rooted:
    case Nil{} True{}:
      Nil{}
    case Nil{} False{}:
      ".." <> Nil{}
    case +unused_head <> tail True{}:
      tail
    case head <> tail False{}:
      App.path.parent.relative(head, tail, String.eq(head, ".."))

def App.path.segment.parent(
  +segment: String,
  +stack: List<&2, String>,
  +rooted: Bool,
  is_parent: Bool
) -> List<&2, String>:
  match is_parent:
    case True{}:
      App.path.parent(stack, rooted)
    case False{}:
      segment <> stack

def App.path.segment.dot(
  +segment: String,
  +stack: List<&2, String>,
  +rooted: Bool,
  is_dot: Bool
) -> List<&2, String>:
  match is_dot:
    case True{}:
      stack
    case False{}:
      App.path.segment.parent(segment, stack, rooted, String.eq(segment, ".."))

def App.path.segment.empty(
  +segment: String,
  +stack: List<&2, String>,
  +rooted: Bool,
  is_empty: Bool
) -> List<&2, String>:
  match is_empty:
    case True{}:
      stack
    case False{}:
      App.path.segment.dot(segment, stack, rooted, String.eq(segment, "."))

def App.path.segment(
  +segment: String,
  +stack: List<&2, String>,
  +rooted: Bool
) -> List<&2, String>:
  App.path.segment.empty(segment, stack, rooted, String.is_empty(segment))

def App.path.normalize.go(
  parts: List<&2, String>,
  stack: List<&2, String>,
  +rooted: Bool
) -> List<&2, String>:
  match parts:
    case Nil{}:
      List.reverse(&2, String, stack)
    case head <> tail:
      App.path.normalize.go(
        tail,
        App.path.segment(head, stack, rooted),
        rooted
      )

def App.path.render(parts: List<&2, String>) -> String:
  match parts:
    case Nil{}:
      ""
    case head <> Nil{}:
      head
    case head <> tail:
      String.append(String.append(head, "/"), App.path.render(tail))

def App.path.root(+rendered: String, rooted: Bool) -> String:
  match rooted:
    case True{}:
      String.append("/", rendered)
    case False{}:
      rendered

def App.import.namespace.trim(+normalized: String) -> String:
  String.take(normalized, Nat.sub(String.length(normalized), 5n))

def App.import.namespace.rooted(+specifier: String, +rooted: Bool) -> String:
  App.import.namespace.trim(App.path.root(
    App.path.render(App.path.normalize.go(
      String.split(specifier, '/'),
      Nil{},
      rooted
    )),
    rooted
  ))

def App.import.namespace(+specifier: String) -> String:
  App.import.namespace.rooted(specifier, String.starts_with(specifier, "/"))

# Each point denotes the state immediately after one direct import and carries
# the exact suffix still to check. Hub imports terminate the reusable prefix
# until their source paths are represented in the graph.
type PrefixPoint is Data:
  PrefixPoint{
    key: M.Digest,
    rest: List<&2, G.ImportEdge>
  }

def App.prefix.points.go(
  edges: List<&2, G.ImportEdge>,
  +prefix: M.Digest
) -> List<&2, PrefixPoint>:
  match edges:
    case Nil{}:
      Nil{}
    case G.ImportEdge{S.ImportHub{}, specifier, alias, target, edge_key} <> rest:
      Nil{}
    case +edge <> +rest:
      PrefixPoint{
        M.Key.prefix_step(prefix, G.Graph.edge.digest(edge)),
        rest
      } <> App.prefix.points.go(
        rest,
        M.Key.prefix_step(prefix, G.Graph.edge.digest(edge))
      )

def App.prefix.points(+compiler: M.Digest, +graph: G.Graph) -> List<&2, PrefixPoint>:
  List.reverse(
    &2,
    PrefixPoint,
    App.prefix.points.go(
      G.Graph.node.imports(G.Graph.root(graph)),
      App.prefix.start(compiler, graph)
    )
  )

def App.fail(message: String) -> IO(Unit):
  IO.die(Unit, 1, message)

def App.success(message: String) -> IO(Unit):
  IO.print(message)

def App.stage.fail(stage: H.Stage, +message: String) -> IO(Unit):
  do IO<Unit>:
    H.Host.stage_abort(stage)
    App.fail(message)

# Terminal artifact publication after a stable checked state.
def App.artifact_built(result: Result<&2, &2, String, Unit>) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{value}:
      App.success("built and cached artifact")

def App.publish(
  +cache: String,
  +artifact_key: String,
  +output: String,
  +target: String,
  state: H.Checkpoint
) -> IO(Unit):
  do IO<Unit>:
    result : Result<&2, &2, String, Unit> <- H.Host.artifact_build(
      cache,
      artifact_key,
      output,
      target,
      state
    )
    App.artifact_built(result)

# A cached final state is already committed. Revalidate the graph before using
# it so an artifact is never published for a graph that changed after lookup.
def App.cached.same(
  +cache: String,
  +artifact_key: String,
  +output: String,
  +target: String,
  state: H.Checkpoint,
  same: Bool
) -> IO(Unit):
  match same:
    case False{}:
      App.fail("source inputs changed during compilation; no artifact was published")
    case True{}:
      App.publish(cache, artifact_key, output, target, state)

def App.cached.stable(
  +cache: String,
  +original: G.Graph,
  +artifact_key: String,
  +output: String,
  +target: String,
  state: H.Checkpoint,
  rebuilt: Result<&2, &2, String, G.Graph>
) -> IO(Unit):
  match rebuilt:
    case Fail{error}:
      App.fail(error)
    case Done{graph}:
      App.cached.same(
        cache,
        artifact_key,
        output,
        target,
        state,
        String.eq(
          M.Digest.hex(G.Graph.node.key(G.Graph.root(original))),
          M.Digest.hex(G.Graph.node.key(G.Graph.root(graph)))
        )
      )

def App.cached.recheck(
  +entry: String,
  +base_path: String,
  +cache: String,
  +compiler: M.Digest,
  +graph: G.Graph,
  +artifact_key: String,
  +output: String,
  +target: String,
  state: H.Checkpoint
) -> IO(Unit):
  do IO<Unit>:
    rebuilt : Result<&2, &2, String, G.Graph> <- G.Graph.build(
      entry,
      compiler,
      base_path,
      100000n
    )
    App.cached.stable(
      cache,
      graph,
      artifact_key,
      output,
      target,
      state,
      rebuilt
    )

# Newly checked states remain provisional until the second graph observation.
# This prevents an input race from poisoning a content-addressed checkpoint.
def App.staged.committed(
  +cache: String,
  +artifact_key: String,
  +output: String,
  +target: String,
  state: H.Checkpoint,
  result: Result<&2, &2, String, Unit>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{value}:
      App.publish(cache, artifact_key, output, target, state)

def App.staged.commit(
  +cache: String,
  +artifact_key: String,
  +output: String,
  +target: String,
  state: H.Checkpoint,
  stage: H.Stage
) -> IO(Unit):
  do IO<Unit>:
    result : Result<&2, &2, String, Unit> <- H.Host.stage_commit(stage)
    App.staged.committed(cache, artifact_key, output, target, state, result)

def App.staged.same(
  +cache: String,
  +artifact_key: String,
  +output: String,
  +target: String,
  state: H.Checkpoint,
  stage: H.Stage,
  same: Bool
) -> IO(Unit):
  match same:
    case False{}:
      App.stage.fail(
        stage,
        "source inputs changed during compilation; no checkpoint or artifact was published"
      )
    case True{}:
      App.staged.commit(cache, artifact_key, output, target, state, stage)

def App.staged.stable(
  +cache: String,
  +original: G.Graph,
  +artifact_key: String,
  +output: String,
  +target: String,
  state: H.Checkpoint,
  stage: H.Stage,
  rebuilt: Result<&2, &2, String, G.Graph>
) -> IO(Unit):
  match rebuilt:
    case Fail{error}:
      App.stage.fail(stage, error)
    case Done{graph}:
      App.staged.same(
        cache,
        artifact_key,
        output,
        target,
        state,
        stage,
        String.eq(
          M.Digest.hex(G.Graph.node.key(G.Graph.root(original))),
          M.Digest.hex(G.Graph.node.key(G.Graph.root(graph)))
        )
      )

def App.staged.recheck(
  +entry: String,
  +base_path: String,
  +cache: String,
  +compiler: M.Digest,
  +graph: G.Graph,
  +artifact_key: String,
  +output: String,
  +target: String,
  state: H.Checkpoint,
  stage: H.Stage
) -> IO(Unit):
  do IO<Unit>:
    rebuilt : Result<&2, &2, String, G.Graph> <- G.Graph.build(
      entry,
      compiler,
      base_path,
      100000n
    )
    App.staged.stable(
      cache,
      graph,
      artifact_key,
      output,
      target,
      state,
      stage,
      rebuilt
    )

# A compile plan is pure Bend data. It specifies the exact ordered suffix,
# namespace and cache key; the TypeScript host only interprets the plan.
def App.plan.go(
  edges: List<&2, G.ImportEdge>,
  +prefix: M.Digest
) -> List<&2, H.CompileStep>:
  match edges:
    case Nil{}:
      Nil{}
    case G.ImportEdge{S.ImportHub{}, specifier, alias, target, edge_key} <> rest:
      Nil{}
    case G.ImportEdge{S.ImportBase{}, specifier, alias, file, +edge_key} <> +rest:
      H.CompileStep{
        file,
        "",
        M.Digest.hex(M.Key.prefix_step(prefix, edge_key))
      } <> App.plan.go(rest, M.Key.prefix_step(prefix, edge_key))
    case G.ImportEdge{S.ImportLocal{}, specifier, alias, file, +edge_key} <> +rest:
      H.CompileStep{
        file,
        App.import.namespace(specifier),
        M.Digest.hex(M.Key.prefix_step(prefix, edge_key))
      } <> App.plan.go(rest, M.Key.prefix_step(prefix, edge_key))

def App.resume.candidates(
  points: List<&2, PrefixPoint>
) -> List<&2, H.ResumeCandidate>:
  match points:
    case Nil{}:
      Nil{}
    case PrefixPoint{+key, rest} <> points:
      H.ResumeCandidate{
        M.Digest.hex(key),
        App.plan.go(rest, key)
      } <> App.resume.candidates(points)

def App.compile.done(
  +entry: String,
  +base_path: String,
  +cache: String,
  +compiler: M.Digest,
  +graph: G.Graph,
  +artifact_key: String,
  +output: String,
  +target: String,
  result: Result<&2, &1, String, H.Checkpoint & H.Stage>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{pair}:
      (state, stage) = pair
      App.staged.recheck(
        entry,
        base_path,
        cache,
        compiler,
        graph,
        artifact_key,
        output,
        target,
        state,
        stage
      )

def App.compile.start(
  +entry: String,
  +base_path: String,
  +cache: String,
  +compiler: M.Digest,
  +graph: G.Graph,
  +state_key: String,
  +artifact_key: String,
  +output: String,
  +target: String,
  +steps: List<&2, H.CompileStep>,
  seed: Maybe<&1, H.Checkpoint>,
  stage: H.Stage
) -> IO(Unit):
  do IO<Unit>:
    checked : Result<&2, &1, String, H.Checkpoint & H.Stage> <- H.Host.book_read_suffix(
      cache,
      entry,
      state_key,
      steps,
      seed,
      stage
    )
    App.compile.done(
      entry,
      base_path,
      cache,
      compiler,
      graph,
      artifact_key,
      output,
      target,
      checked
    )

def App.resume.found(
  +entry: String,
  +base_path: String,
  +cache: String,
  +compiler: M.Digest,
  +graph: G.Graph,
  +state_key: String,
  +artifact_key: String,
  +output: String,
  +target: String,
  +cold_steps: List<&2, H.CompileStep>,
  stage: H.Stage,
  result: Result<&2, &1, String, Maybe<&1, H.Checkpoint & List<&2, H.CompileStep>>>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.stage.fail(stage, error)
    case Done{None{}}:
      App.compile.start(
        entry, base_path, cache, compiler, graph, state_key,
        artifact_key, output, target, cold_steps, None{}, stage
      )
    case Done{Some{pair}}:
      (state, steps) = pair
      App.compile.start(
        entry, base_path, cache, compiler, graph, state_key,
        artifact_key, output, target, steps, Some{state}, stage
      )

def App.stage.started(
  +entry: String,
  +base_path: String,
  +cache: String,
  +compiler: M.Digest,
  +graph: G.Graph,
  +state_key: String,
  +artifact_key: String,
  +output: String,
  +target: String,
  result: Result<&2, &1, String, H.Stage>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{stage}:
      do IO<Unit>:
        found : Result<&2, &1, String, Maybe<&1, H.Checkpoint & List<&2, H.CompileStep>>> <- H.Host.state_get_longest(
          cache,
          App.resume.candidates(App.prefix.points(compiler, graph))
        )
        App.resume.found(
          entry,
          base_path,
          cache,
          compiler,
          graph,
          state_key,
          artifact_key,
          output,
          target,
          App.plan.go(
            G.Graph.node.imports(G.Graph.root(graph)),
            App.prefix.start(compiler, graph)
          ),
          stage,
          found
        )

def App.state_found(
  +entry: String,
  +base_path: String,
  +cache: String,
  +compiler: M.Digest,
  +graph: G.Graph,
  +state_key: String,
  +artifact_key: String,
  +output: String,
  +target: String,
  result: Result<&2, &1, String, Maybe<&1, H.Checkpoint>>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{Some{state}}:
      App.cached.recheck(
        entry,
        base_path,
        cache,
        compiler,
        graph,
        artifact_key,
        output,
        target,
        state
      )
    case Done{None{}}:
      do IO<Unit>:
        started : Result<&2, &1, String, H.Stage> <- H.Host.stage_start()
        App.stage.started(
          entry,
          base_path,
          cache,
          compiler,
          graph,
          state_key,
          artifact_key,
          output,
          target,
          started
        )

def App.restored.same(+output: String, same: Bool) -> IO(Unit):
  match same:
    case False{}:
      do IO<Unit>:
        H.Host.output_remove(output)
        App.fail("source inputs changed during cache restoration; output was removed")
    case True{}:
      App.success("restored artifact from cache")

def App.restored.stable(
  +original: G.Graph,
  +output: String,
  result: Result<&2, &2, String, G.Graph>
) -> IO(Unit):
  match result:
    case Fail{error}:
      do IO<Unit>:
        H.Host.output_remove(output)
        App.fail(error)
    case Done{graph}:
      App.restored.same(
        output,
        String.eq(
          M.Digest.hex(G.Graph.node.key(G.Graph.root(original))),
          M.Digest.hex(G.Graph.node.key(G.Graph.root(graph)))
        )
      )

def App.restored.recheck(
  +entry: String,
  +base_path: String,
  +compiler: M.Digest,
  +graph: G.Graph,
  +output: String
) -> IO(Unit):
  do IO<Unit>:
    rebuilt : Result<&2, &2, String, G.Graph> <- G.Graph.build(
      entry,
      compiler,
      base_path,
      100000n
    )
    App.restored.stable(graph, output, rebuilt)

def App.artifact_restored(
  +entry: String,
  +base_path: String,
  +cache: String,
  +compiler: M.Digest,
  +graph: G.Graph,
  +state_key: String,
  +artifact_key: String,
  +output: String,
  +target: String,
  result: Result<&2, &2, String, Bool>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{True{}}:
      App.restored.recheck(entry, base_path, compiler, graph, output)
    case Done{False{}}:
      do IO<Unit>:
        found : Result<&2, &1, String, Maybe<&1, H.Checkpoint>> <- H.Host.state_get(
          cache,
          state_key
        )
        App.state_found(
          entry,
          base_path,
          cache,
          compiler,
          graph,
          state_key,
          artifact_key,
          output,
          target,
          found
        )

def App.graph_ready(
  +entry: String,
  +base_path: String,
  +cache: String,
  +compiler: M.Digest,
  +output: String,
  +target: String,
  +result: Result<&2, &2, String, G.Graph>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{graph}:
      do IO<Unit>:
        restored : Result<&2, &2, String, Bool> <- H.Host.artifact_restore(
          cache,
          M.Digest.hex(App.artifact_key(compiler, graph, target)),
          output
        )
        App.artifact_restored(
          entry,
          base_path,
          cache,
          compiler,
          graph,
          M.Digest.hex(App.state_key(compiler, graph)),
          M.Digest.hex(App.artifact_key(compiler, graph, target)),
          output,
          target,
          restored
        )

def App.compiler_ready(
  +entry: String,
  +base_path: String,
  +cache: String,
  +output: String,
  +target: String,
  +result: Result<&2, &2, String, H.CompilerInputs>
) -> IO(Unit):
  match result:
    case Fail{error}:
      App.fail(error)
    case Done{inputs}:
      do IO<Unit>:
        graph : Result<&2, &2, String, G.Graph> <- G.Graph.build(
          entry,
          App.compiler_key(inputs),
          base_path,
          100000n
        )
        App.graph_ready(
          entry,
          base_path,
          cache,
          App.compiler_key(inputs),
          output,
          target,
          graph
        )

def App.build(
  +entry: String,
  +base_path: String,
  +output: String,
  +target: String
) -> IO(Unit):
  do IO<Unit>:
    cache : String <- H.Host.cache_root("bend-proof-of-compile", "v1")
    inputs : Result<&2, &2, String, H.CompilerInputs> <- H.Host.compiler_inputs()
    App.compiler_ready(entry, base_path, cache, output, target, inputs)

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

def Cli.gc(cache: String) -> IO(Unit):
  do IO<Unit>:
    result : Result<&2, &2, String, String> <- H.Host.cache_gc(cache, Nil{})
    Cli.report(result)

def Cli.build.options(
  args: List<&1, String>,
  +entry: String,
  +base_path: String,
  +output: String,
  +target: String
) -> IO(Unit):
  match args:
    case Nil{}:
      App.build(entry, base_path, output, target)
    case "--base" <> value <> rest:
      Cli.build.options(rest, entry, value, output, target)
    case "--output" <> value <> rest:
      Cli.build.options(rest, entry, base_path, value, target)
    case "--target" <> "js" <> rest:
      Cli.build.options(rest, entry, base_path, output, "js")
    case "--target" <> "c" <> rest:
      Cli.build.options(rest, entry, base_path, output, "c")
    case value <> rest:
      App.fail(String.append("unknown or incomplete build option: ", value))

def Cli.run(
  args: List<&1, String>,
  default_base: String,
  cache: String
) -> IO(Unit):
  match args:
    case "build" <> entry <> rest:
      Cli.build.options(rest, entry, default_base, "out.js", "js")
    case "cache" <> "status" <> Nil{}:
      Cli.status(cache)
    case "cache" <> "verify" <> Nil{}:
      Cli.verify(cache)
    case "cache" <> "gc" <> Nil{}:
      Cli.gc(cache)
    case _:
      App.fail(
        "usage: poc build ENTRY [--base FILE] [--target js|c] [--output FILE] | poc cache status|verify|gc"
      )

def Cli.program(args: List<&1, String>) -> IO(Unit):
  do IO<Unit>:
    base_path : String <- H.Host.default_base()
    cache : String <- H.Host.cache_root("bend-proof-of-compile", "v1")
    Cli.run(args, base_path, cache)

def main() -> IO(Unit):
  do IO<Unit>:
    args : List<&1, String> <- IO.args()
    Cli.program(args)
