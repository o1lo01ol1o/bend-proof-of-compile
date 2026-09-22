import Base
import ./Host.bend as H
import ./Merkle.bend as M
import ./Source.bend as S

type ResolvedImport is Data:
  ResolvedImport{kind: S.ImportKind, specifier: String, alias: String, target: String}

type ResolvedForeign is Data:
  ResolvedForeign{path: String, key: M.Digest}

type ImportEdge is Data:
  ImportEdge{
    kind: S.ImportKind,
    specifier: String,
    alias: String,
    target: String,
    key: M.Digest
  }

type Node is Data:
  Node{path: String, key: M.Digest, imports: List<&2, ImportEdge>}

type Graph is Data:
  Graph{root: Node, nodes: Map<&2, Node>}

type GraphState is Data:
  GraphState{
    root: String,
    compiler: M.Digest,
    base_path: String,
    nodes: Map<&2, Node>,
    active: Map<&2, Bool>
  }

type Work is Data:
  Visit{path: String}
  Real{result: Result<&2, &2, String, String>}
  Status{path: String, known: Bool, active: Bool}
  Read{path: String, result: Result<&2, &2, String, H.SourceFile>}
  Parsed{path: String, content: M.Digest, result: Result<&2, &2, String, S.ParsedSource>}
  Imports{
    path: String,
    content: M.Digest,
    rest: List<&2, S.Import>,
    foreigns: List<&2, String>,
    done: List<&2, ResolvedImport>
  }
  Local{
    path: String,
    content: M.Digest,
    item: S.Import,
    rest: List<&2, S.Import>,
    foreigns: List<&2, String>,
    done: List<&2, ResolvedImport>,
    result: Result<&2, &2, String, String>
  }
  Foreigns{
    path: String,
    content: M.Digest,
    imports: List<&2, ResolvedImport>,
    rest: List<&2, String>,
    done: List<&2, ResolvedForeign>
  }
  ForeignPath{
    path: String,
    content: M.Digest,
    imports: List<&2, ResolvedImport>,
    specifier: String,
    rest: List<&2, String>,
    done: List<&2, ResolvedForeign>,
    result: Result<&2, &2, String, String>
  }
  ForeignRead{
    path: String,
    content: M.Digest,
    imports: List<&2, ResolvedImport>,
    foreign_path: String,
    rest: List<&2, String>,
    done: List<&2, ResolvedForeign>,
    result: Result<&2, &2, String, H.SourceFile>
  }
  Finish{
    path: String,
    content: M.Digest,
    imports: List<&2, ResolvedImport>,
    foreigns: List<&2, ResolvedForeign>
  }

# Total map observations. The map itself is copied from GraphState; the
# observation consumes only that copy.
def Graph.has.fin(-V: Data, pair: Map<&2, V> & Bool) -> Bool:
  (map, found) = pair
  found

def Graph.has(-V: Data, +map: Map<&2, V>, +key: String) -> Bool:
  Graph.has.fin(V, Map.has(&2, V, map, key))

def Graph.node.fin(pair: Map<&2, Node> & Node) -> Node:
  (map, node) = pair
  node

def Graph.node(+map: Map<&2, Node>, +path: String) -> Node:
  missing : Node = Node{"", M.Sequence.empty("missing-node"), Nil{}}
  Graph.node.fin(Map.get(Node, missing, map, path))

def Graph.node.path(+node: Node) -> String:
  match node:
    case Node{path, key, imports}:
      path

def Graph.node.key(+node: Node) -> M.Digest:
  match node:
    case Node{path, key, imports}:
      key

def Graph.node.imports(+node: Node) -> List<&2, ImportEdge>:
  match node:
    case Node{path, key, imports}:
      imports

def Graph.edge.digest(+edge: ImportEdge) -> M.Digest:
  match edge:
    case ImportEdge{kind, specifier, alias, target, key}:
      key

def Graph.root(+graph: Graph) -> Node:
  match graph:
    case Graph{root, nodes}:
      root

def Graph.state.root(+state: GraphState) -> String:
  match state:
    case GraphState{root, compiler, base_path, nodes, active}:
      root

def Graph.state.compiler(+state: GraphState) -> M.Digest:
  match state:
    case GraphState{root, compiler, base_path, nodes, active}:
      compiler

def Graph.state.base(+state: GraphState) -> String:
  match state:
    case GraphState{root, compiler, base_path, nodes, active}:
      base_path

def Graph.state.nodes(+state: GraphState) -> Map<&2, Node>:
  match state:
    case GraphState{root, compiler, base_path, nodes, active}:
      nodes

def Graph.state.active(+state: GraphState) -> Map<&2, Bool>:
  match state:
    case GraphState{root, compiler, base_path, nodes, active}:
      active

# Pure key folds
# --------------

def Graph.edge.key(
  +compiler: M.Digest,
  +base_path: String,
  +nodes: Map<&2, Node>,
  +edge: ResolvedImport
) -> ImportEdge:
  match edge:
    case ResolvedImport{S.ImportBase{}, specifier, alias, target}:
      ImportEdge{
        S.ImportBase{},
        specifier,
        alias,
        base_path,
        M.Key.import_base(compiler, base_path, alias)
      }
    case ResolvedImport{S.ImportHub{}, specifier, alias, target}:
      ImportEdge{
        S.ImportHub{},
        specifier,
        alias,
        target,
        M.Key.import_hub(specifier, alias)
      }
    case ResolvedImport{S.ImportLocal{}, specifier, alias, target}:
      node = Graph.node(nodes, target)
      ImportEdge{
        S.ImportLocal{},
        specifier,
        alias,
        target,
        M.Key.import_local(specifier, alias, Graph.node.key(node))
      }

def Graph.edges(
  +compiler: M.Digest,
  +base_path: String,
  +nodes: Map<&2, Node>,
  imports: List<&2, ResolvedImport>
) -> List<&2, ImportEdge>:
  match imports:
    case Nil{}:
      Nil{}
    case head <> tail:
      Graph.edge.key(compiler, base_path, nodes, head)
        <> Graph.edges(compiler, base_path, nodes, tail)

def Graph.import_key.go(
  edges: List<&2, ImportEdge>,
  key: M.Digest
) -> M.Digest:
  match edges:
    case Nil{}:
      key
    case ImportEdge{kind, specifier, alias, target, edge_key} <> tail:
      Graph.import_key.go(tail, M.Sequence.snoc("source-imports", key, edge_key))

def Graph.import_key(edges: List<&2, ImportEdge>) -> M.Digest:
  Graph.import_key.go(edges, M.Sequence.empty("source-imports"))

def Graph.foreign_key.go(
  foreigns: List<&2, ResolvedForeign>,
  key: M.Digest
) -> M.Digest:
  match foreigns:
    case Nil{}:
      key
    case ResolvedForeign{path, content} <> tail:
      item : M.Digest = M.Key.foreign(path, content)
      Graph.foreign_key.go(
        tail,
        M.Sequence.snoc("source-foreign-inputs", key, item)
      )

def Graph.foreign_key(foreigns: List<&2, ResolvedForeign>) -> M.Digest:
  Graph.foreign_key.go(foreigns, M.Sequence.empty("source-foreign-inputs"))

# Child visits are pushed before Finish, yielding an explicit post-order graph
# traversal without hidden general recursion.
def Graph.children(
  imports: List<&2, ResolvedImport>,
  tail: List<&2, Work>
) -> List<&2, Work>:
  match imports:
    case Nil{}:
      tail
    case ResolvedImport{S.ImportLocal{}, specifier, alias, target} <> rest:
      Visit{target} <> Graph.children(rest, tail)
    case ResolvedImport{S.ImportBase{}, specifier, alias, target} <> rest:
      Graph.children(rest, tail)
    case ResolvedImport{S.ImportHub{}, specifier, alias, target} <> rest:
      Graph.children(rest, tail)

# The graph machine is fuelled. Exhaustion is a typed failure, not divergence;
# each transition consumes exactly one unit of fuel.
def Graph.loop(
  fuel: Nat,
  work: List<&2, Work>,
  +state: GraphState
) -> IO(Result<&2, &2, String, Graph>):
  match fuel work:
    case 0n _:
      IO.pure(Result<&2, &2, String, Graph>, Fail{"source graph exceeded traversal fuel"})
    case 1n+fuel Nil{}:
      root : Node = Graph.node(Graph.state.nodes(state), Graph.state.root(state))
      IO.pure(Result<&2, &2, String, Graph>, Done{Graph{root, Graph.state.nodes(state)}})
    case 1n+fuel Visit{path} <> tail:
      do IO<Result<&2, &2, String, Graph>>:
        result : Result<&2, &2, String, String> <- H.Host.realpath(path)
        Graph.loop(fuel, Real{result} <> tail, state)
    case 1n+fuel Real{Fail{error}} <> tail:
      IO.pure(Result<&2, &2, String, Graph>, Fail{error})
    case 1n+fuel Real{Done{+path}} <> tail:
      known : Bool = Graph.has(Node, Graph.state.nodes(state), path)
      active : Bool = Graph.has(Bool, Graph.state.active(state), path)
      Graph.loop(fuel, Status{path, known, active} <> tail, state)
    case 1n+fuel Status{+unused_path, True{}, +unused_active} <> tail:
      Graph.loop(fuel, tail, state)
    case 1n+fuel Status{path, False{}, True{}} <> tail:
      IO.pure(
        Result<&2, &2, String, Graph>,
        Fail{String.append("import cycle through ", path)}
      )
    case 1n+fuel Status{+path, False{}, False{}} <> tail:
      next : GraphState = GraphState{
        Bool.pick(
          String,
          String.is_empty(Graph.state.root(state)),
          path,
          Graph.state.root(state)
        ),
        Graph.state.compiler(state),
        Graph.state.base(state),
        Graph.state.nodes(state),
        Map.set(&2, Bool, Graph.state.active(state), path, True{})
      }
      do IO<Result<&2, &2, String, Graph>>:
        result : Result<&2, &2, String, H.SourceFile> <- H.Host.read_source(path)
        Graph.loop(fuel, Read{path, result} <> tail, next)
    case 1n+fuel Read{+unused_path, Fail{error}} <> +unused_tail:
      IO.pure(Result<&2, &2, String, Graph>, Fail{error})
    case 1n+fuel Read{path, Done{H.SourceFile{+unused_text, lines, bytes}}} <> tail:
      Graph.loop(
        fuel,
        Parsed{path, M.Key.file_bytes(bytes), S.Source.parse_lines(lines)} <> tail,
        state
      )
    case 1n+fuel Parsed{path, +unused_content, Fail{error}} <> +unused_tail:
      IO.pure(
        Result<&2, &2, String, Graph>,
        Fail{String.append(String.append(path, ": "), error)}
      )
    case 1n+fuel Parsed{path, content, Done{S.ParsedSource{imports, foreigns}}} <> tail:
      Graph.loop(
        fuel,
        Imports{path, content, imports, foreigns, Nil{}} <> tail,
        state
      )
    case 1n+fuel Imports{+path, content, Nil{}, foreigns, done} <> tail:
      Graph.loop(
        fuel,
        Foreigns{path, content, List.reverse(&2, ResolvedImport, done), foreigns, Nil{}}
          <> tail,
        state
      )
    case 1n+fuel Imports{
      path, content, S.Import{S.ImportBase{}, +specifier, +alias} <> rest, foreigns, done
    } <> tail:
      resolved : ResolvedImport = ResolvedImport{S.ImportBase{}, specifier, alias, ""}
      Graph.loop(
        fuel,
        Imports{path, content, rest, foreigns, resolved <> done} <> tail,
        state
      )
    case 1n+fuel Imports{
      path, content, S.Import{S.ImportHub{}, +specifier, +alias} <> rest, foreigns, done
    } <> tail:
      resolved : ResolvedImport = ResolvedImport{S.ImportHub{}, specifier, alias, ""}
      Graph.loop(
        fuel,
        Imports{path, content, rest, foreigns, resolved <> done} <> tail,
        state
      )
    case 1n+fuel Imports{
      path, content, S.Import{S.ImportLocal{}, +specifier, +alias} <> rest, foreigns, done
    } <> tail:
      do IO<Result<&2, &2, String, Graph>>:
        result : Result<&2, &2, String, String> <- H.Host.resolve(path, specifier)
        Graph.loop(
          fuel,
          Local{
            path,
            content,
            S.Import{S.ImportLocal{}, specifier, alias},
            rest,
            foreigns,
            done,
            result
          } <> tail,
          state
        )
    case 1n+fuel Local{
      +unused_path,
      +unused_content,
      +unused_item,
      +unused_rest,
      +unused_foreigns,
      +unused_done,
      Fail{error}
    } <> +unused_tail:
      IO.pure(Result<&2, &2, String, Graph>, Fail{error})
    case 1n+fuel Local{
      path, content, S.Import{kind, specifier, alias}, rest, foreigns, done, Done{target}
    } <> tail:
      resolved : ResolvedImport = ResolvedImport{kind, specifier, alias, target}
      Graph.loop(
        fuel,
        Imports{path, content, rest, foreigns, resolved <> done} <> tail,
        state
      )
    case 1n+fuel Foreigns{path, content, +imports, Nil{}, done} <> tail:
      ordered : List<&2, ResolvedForeign> = List.reverse(&2, ResolvedForeign, done)
      finish : Work = Finish{path, content, imports, ordered}
      Graph.loop(fuel, Graph.children(imports, finish <> tail), state)
    case 1n+fuel Foreigns{+path, content, imports, +specifier <> rest, done} <> tail:
      do IO<Result<&2, &2, String, Graph>>:
        result : Result<&2, &2, String, String> <- H.Host.resolve(path, specifier)
        Graph.loop(
          fuel,
          ForeignPath{path, content, imports, specifier, rest, done, result} <> tail,
          state
        )
    case 1n+fuel ForeignPath{
      +unused_path,
      +unused_content,
      +unused_imports,
      +unused_specifier,
      +unused_rest,
      +unused_done,
      Fail{error}
    } <> +unused_tail:
      IO.pure(Result<&2, &2, String, Graph>, Fail{error})
    case 1n+fuel ForeignPath{path, content, imports, specifier, rest, done, Done{+foreign_path}} <> tail:
      do IO<Result<&2, &2, String, Graph>>:
        result : Result<&2, &2, String, H.SourceFile> <- H.Host.read_source(foreign_path)
        Graph.loop(
          fuel,
          ForeignRead{path, content, imports, foreign_path, rest, done, result} <> tail,
          state
        )
    case 1n+fuel ForeignRead{
      +unused_path,
      +unused_content,
      +unused_imports,
      +unused_foreign_path,
      +unused_rest,
      +unused_done,
      Fail{error}
    } <> +unused_tail:
      IO.pure(Result<&2, &2, String, Graph>, Fail{error})
    case 1n+fuel ForeignRead{
      path, content, imports, foreign_path, rest, done,
      Done{H.SourceFile{+unused_text, +unused_lines, bytes}}
    } <> tail:
      foreign : ResolvedForeign = ResolvedForeign{foreign_path, M.Key.file_bytes(bytes)}
      Graph.loop(
        fuel,
        Foreigns{path, content, imports, rest, foreign <> done} <> tail,
        state
      )
    case 1n+fuel Finish{+path, content, +imports, foreigns} <> tail:
      key : M.Digest = M.Key.source(
        path,
        content,
        Graph.import_key(Graph.edges(
          Graph.state.compiler(state),
          Graph.state.base(state),
          Graph.state.nodes(state),
          imports
        )),
        Graph.foreign_key(foreigns)
      )
      node : Node = Node{
        path,
        key,
        Graph.edges(
          Graph.state.compiler(state),
          Graph.state.base(state),
          Graph.state.nodes(state),
          imports
        )
      }
      next : GraphState = GraphState{
        Graph.state.root(state),
        Graph.state.compiler(state),
        Graph.state.base(state),
        Map.set(&2, Node, Graph.state.nodes(state), path, node),
        Map.set(&2, Bool, Graph.state.active(state), path, False{})
      }
      Graph.loop(fuel, tail, next)

def Graph.build(
  entry: String,
  compiler: M.Digest,
  base_path: String,
  fuel: Nat
) -> IO(Result<&2, &2, String, Graph>):
  state : GraphState = GraphState{
    "",
    compiler,
    base_path,
    Map.new(&2, Node),
    Map.new(&2, Bool)
  }
  Graph.loop(fuel, Visit{entry} <> Nil{}, state)
