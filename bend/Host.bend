import Base

# Checked compiler state. The token is an opaque host value at runtime; Bend
# never inspects it. Declaring the wrapper as Type makes it affine, so the
# application cannot duplicate a trusted compiler state.
type Checkpoint is Type:
  Checkpoint{token: U32}

# A stage is an affine transaction of checked states. Checkpoints are written
# to temporary storage as they are produced, then published to the immutable
# CAS only after the source graph has been revalidated.
type Stage is Type:
  Stage{token: U32}

# A source is read once at the boundary. `bytes` is the exact file contents in
# base64; `text` is the UTF-8 view consumed by Bend's compiler.
type SourceFile is Data:
  SourceFile{text: String, lines: List<&2, String>, bytes: String}

type NamedBytes is Data:
  NamedBytes{path: String, bytes: String}

type CompilerInputs is Data:
  CompilerInputs{
    compiler: List<&2, NamedBytes>,
    hashes: List<&2, NamedBytes>
  }

# Bend supplies an exact ordered compiler plan. The host only interprets these
# capabilities; it neither discovers dependencies nor derives keys.
type CompileStep is Data:
  CompileStep{file: String, namespace: String, key: String}

type ResumeCandidate is Data:
  ResumeCandidate{key: String, steps: List<&2, CompileStep>}

# Platform path and source capabilities

def Host.cache_root(namespace: String, version: String) -> IO(String):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.compiler_inputs() -> IO(Result<&2, &2, String, CompilerInputs>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.default_base() -> IO(String):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.realpath(path: String) -> IO(Result<&2, &2, String, String>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.resolve(owner: String, specifier: String) -> IO(Result<&2, &2, String, String>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.read_source(path: String) -> IO(Result<&2, &2, String, SourceFile>):
  import "../foreign/host.c"
  import "../foreign/host.js"

# Checked-state cache capabilities. The CAS implementation validates producer,
# compiler, key and payload digest before returning an unsafe compiler seed.
def Host.state_get(cache: String, key: String) -> IO(Result<&2, &1, String, Maybe<&1, Checkpoint>>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.state_get_longest(
  cache: String,
  candidates: List<&2, ResumeCandidate>
) -> IO(Result<&2, &1, String, Maybe<&1, Checkpoint & List<&2, CompileStep>>>):
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
def Host.book_read_suffix(
  cache: String,
  entry: String,
  state_key: String,
  steps: List<&2, CompileStep>,
  seed: Maybe<&1, Checkpoint>,
  stage: Stage
) -> IO(Result<&2, &1, String, Checkpoint & Stage>):
  import "../foreign/host.c"
  import "../foreign/host.js"

# Artifact CAS capabilities.
def Host.artifact_restore(cache: String, key: String, output: String) -> IO(Result<&2, &2, String, Bool>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.output_remove(output: String) -> IO(Unit):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.artifact_build(cache: String, key: String, output: String, target: String, state: Checkpoint) -> IO(Result<&2, &2, String, Unit>):
  import "../foreign/host.c"
  import "../foreign/host.js"

# Cache administration is intentionally an effect; retention policy is chosen
# by Bend and passed as the exact live-key set.
def Host.cache_status(cache: String) -> IO(Result<&2, &2, String, String>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.cache_verify(cache: String) -> IO(Result<&2, &2, String, String>):
  import "../foreign/host.c"
  import "../foreign/host.js"

def Host.cache_gc(cache: String, live: List<&2, String>) -> IO(Result<&2, &2, String, String>):
  import "../foreign/host.c"
  import "../foreign/host.js"
