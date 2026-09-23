import Base

# Checked compiler state. The token is an opaque host value at runtime; Bend
# never inspects it. Declaring the wrapper as Type makes it affine, so the
# application cannot duplicate a trusted compiler state.
type Checkpoint is Type:
  Checkpoint{token: U32}

# A stage is an affine transaction of checked states. Checkpoints are written
# to temporary storage as they are produced, then published to the immutable
# CAS only after the load order has been observed again, unchanged.
type Stage is Type:
  Stage{token: U32}

type NamedBytes is Data:
  NamedBytes{path: String, bytes: String}

type CompilerInputs is Data:
  CompilerInputs{
    compiler: List<&2, NamedBytes>,
    hashes: List<&2, NamedBytes>
  }

# One file of the checker's load order, as the checker's loader saw it: its
# realpath, the namespace it loads under, and the text it parses (the file's
# UTF-8 decoding: the checker's input). Files are reported after their
# imports; the entry is the last step.
type LoadStep is Data:
  LoadStep{path: String, namespace: String, text: String}

# The checker rejects an entry named PROOF.bend that does not import a
# LAWS.bend beside it. The host observes the entry's name and the realpath of
# that LAWS.bend; Bend applies the rule.
type EntryRule is Data:
  PlainEntry{}
  ProofEntry{laws: Maybe<&2, String>}

# The load order split at its last step, which is always the entry: `imports`
# are the files loaded before it, in order.
type LoadOrder is Data:
  LoadOrder{imports: List<&2, LoadStep>, entry: LoadStep, rule: EntryRule}

# A law declared at step `declared` (1-based) and filled at a later step
# `filled` by a definition that is foreign or @unsafe. A cold check parses
# every file before checking any, so the law's declaration is checked with the
# fill's flags; a state sealed between the two steps was checked without them.
type FillFlag is Data:
  FillForeign{}
  FillUnsafe{}

type LateFill is Data:
  LateFill{declared: Nat, filled: Nat, flags: List<&2, FillFlag>}

# The checker's judgment of an entry's final state: its count of holes and
# open laws, and the entry's own claims that rely on @unsafe or foreign code
# (the checker's report).
type Verdict is Data:
  Verdict{todos: Nat, reliant: List<&2, String>}

# A check plan is pure Bend data: consecutive groups of load steps. The host
# loads each group's files into a child of the previous state, checks them
# together, and stages the resulting state under the group's key.
type CheckGroup is Data:
  CheckGroup{steps: List<&2, LoadStep>, key: String}

type ResumeCandidate is Data:
  ResumeCandidate{key: String, groups: List<&2, CheckGroup>}

# Platform capabilities

# The cache directory. Its objects are signed; only those signed by a trusted
# key are read (trust option (b)).
def Host.cache_root(namespace: String, version: String) -> IO(Result<&2, &2, String, String>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.compiler_inputs() -> IO(Result<&2, &2, String, CompilerInputs>):
  import "../foreign/host.c"
  import "../foreign/host.js"

# How the root file is loaded: as the entry (namespace ""), or as a module,
# under the namespace a sibling importer gives it (`import ./X.bend` loads
# X.bend as `X`), so its final state is the prefix that importer resumes from.
type Role is Data:
  AsEntry{}
  AsModule{}

# The checker's own loader walks the import graph without parsing. It is the
# only import parser: this application never reads import syntax.
def Host.load_steps(entry: String, role: Role) -> IO(Result<&2, &2, String, LoadOrder>):
  import "../foreign/host.c"
  import "../foreign/host.js"

# Parses (without checking) the whole load order rooted at `root`, failing if
# any file differs from `steps`, and reports the laws filled after the step
# that declares them.
def Host.load_fills(
  root: String,
  namespace: String,
  steps: List<&2, LoadStep>
) -> IO(Result<&2, &2, String, List<&2, LateFill>>):
  import "../foreign/host.c"
  import "../foreign/host.js"

# Checked-state cache capabilities. A restored state comes with the checker's
# verdict on it as an entry's final state, which Bend judges.
def Host.state_get(
  cache: String,
  key: String
) -> IO(Result<&2, &1, String, Maybe<&1, Checkpoint & Verdict>>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.state_get_longest(
  cache: String,
  candidates: List<&2, ResumeCandidate>
) -> IO(Result<&2, &1, String, Maybe<&1, Checkpoint & List<&2, CheckGroup>>>):
  import "../foreign/host.c"
  import "../foreign/host.js"

# The foreign files named by the checked records of a committed state, with
# their current bytes; None when no state is committed under the key.
def Host.state_foreigns(
  cache: String,
  key: String
) -> IO(Result<&2, &2, String, Maybe<&2, List<&2, NamedBytes>>>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.stage_start() -> IO(Result<&2, &1, String, Stage>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.stage_commit(stage: Stage) -> IO(Result<&2, &2, String, Unit>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.stage_abort(stage: Stage) -> IO(Unit):
  import "../foreign/host.c"
  import "../foreign/host.js"

# Compiler boundary. This is the only operation that invokes Bend's checker.
# `root` is the entry's realpath, loaded under `namespace`; `seed` is the state
# the first group extends.
# The result is the final state, the stage, and the verdict on the final state.
def Host.book_check(
  cache: String,
  root: String,
  namespace: String,
  groups: List<&2, CheckGroup>,
  seed: Maybe<&1, Checkpoint>,
  stage: Stage
) -> IO(Result<&2, &1, String, Checkpoint & Stage & Verdict>):
  import "../foreign/host.c"
  import "../foreign/host.js"

# The output path as the checker's CLI resolves it (realpath when it exists).
type OutputPath is Data:
  OutputFile{real: String}
  OutputDirectory{real: String}

def Host.output_path(output: String) -> IO(Result<&2, &2, String, OutputPath>):
  import "../foreign/host.c"
  import "../foreign/host.js"

# Artifact CAS capabilities. A restored artifact comes with the report of the
# build that made it.
def Host.artifact_restore(
  cache: String,
  key: String,
  output: String
) -> IO(Result<&2, &2, String, Maybe<&2, List<&2, String>>>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.output_remove(output: String) -> IO(Unit):
  import "../foreign/host.c"
  import "../foreign/host.js"

# Emits the final state (a state with restored records, which carry no
# elaborations, first re-elaborates what `main` reaches) and stores the
# artifact with the build's report.
def Host.artifact_build(
  cache: String,
  key: String,
  output: String,
  target: String,
  state: Checkpoint,
  reliant: List<&2, String>
) -> IO(Result<&2, &2, String, Unit>):
  import "../foreign/host.c"
  import "../foreign/host.js"

# Retention. A build records the keys it keeps alive (its final state, and
# its artifact when it emits) under a root named by Bend; `roots_live` is the
# union of every recorded root.
def Host.roots_put(cache: String, root: String, live: List<&2, String>) -> IO(Result<&2, &2, String, Unit>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.roots_live(cache: String) -> IO(Result<&2, &2, String, List<&2, String>>):
  import "../foreign/host.c"
  import "../foreign/host.js"

# Cache administration is intentionally an effect; retention policy is chosen
# by Bend and passed as the exact live-key set. GC keeps each live state's
# chain of packs and deletes every other object.
def Host.cache_status(cache: String) -> IO(Result<&2, &2, String, String>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.cache_verify(cache: String) -> IO(Result<&2, &2, String, String>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.cache_gc(cache: String, live: List<&2, String>) -> IO(Result<&2, &2, String, String>):
  import "../foreign/host.c"
  import "../foreign/host.js"
