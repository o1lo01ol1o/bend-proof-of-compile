import Base
import ../vendor/bend-hashes/sha2_32.bend as Hash

# Proof-of-compile Merkle core
# ============================
#
# This is the production implementation of cache-key derivation. TypeScript
# supplies boundary data (paths, source bytes encoded as base64, and compiler
# state handles); it does not reproduce these constructors or hash frames.

# A digest is abstract by convention: callers use the Key functions below.
# Bend has no private constructors, so the JS boundary additionally checks that
# returned and restored digest strings contain exactly 64 lowercase hex digits.
type Digest is Data:
  Digest{hex: String}

def Digest.hex(digest: Digest) -> String:
  match digest:
    case Digest{hex}:
      hex

# The binary initial algebra used by every key. Ordered n-ary collections are
# represented by Sequence.empty / Sequence.snoc below, not by ad-hoc string
# concatenation at callers.
type Merkle is Data:
  Empty{}
  Leaf{domain: String, payload: String}
  Fork{domain: String, payload: String, left: Merkle, right: Merkle}

# Hashes an atom before it enters a node. Every concatenated component below is
# therefore a fixed-width SHA-256 digest, making the frame prefix-free.
def Merkle.atom(domain: String, payload: String) -> String:
  Hash.SHA256.text("bend-proof-of-compile:atom:v1:" ++ Hash.SHA256.text(domain) ++ Hash.SHA256.text(payload))

# The catamorphism from Merkle into Digest. Its recursion tree is also a valid
# fork/join schedule: the two children of a Fork are independent.
def Merkle.digest(tree: Merkle) -> Digest:
  match tree:
    case Empty{}:
      Digest{Hash.SHA256.text("bend-proof-of-compile:empty:v1")}
    case Leaf{domain, payload}:
      Digest{Hash.SHA256.text("bend-proof-of-compile:leaf:v1:" ++ Merkle.atom(domain, payload))}
    case Fork{domain, payload, left, right}:
      left_hash right_hash = Merkle.digest(left) Merkle.digest(right)
      Digest{Hash.SHA256.text("bend-proof-of-compile:fork:v1:" ++ Merkle.atom(domain, payload) ++ Digest.hex(left_hash) ++ Digest.hex(right_hash))}

# Smart constructors for ordered collections. The domain is present in every
# step, so two collections used for different semantic roles cannot alias merely
# because their elements coincide.
def Sequence.empty(domain: String) -> Digest:
  Merkle.digest(Leaf{"sequence-empty", domain})

def Sequence.snoc(domain: String, prefix: Digest, item: Digest) -> Digest:
  Merkle.digest(Fork{
    "sequence-snoc",
    domain,
    Leaf{"digest", Digest.hex(prefix)},
    Leaf{"digest", Digest.hex(item)}
  })

# Boundary leaves
# ---------------

def Key.file_bytes(base64: String) -> Digest:
  Merkle.digest(Leaf{"file-bytes-base64", base64})

# A source file as the checker reads it: its UTF-8 text.
def Key.file_text(text: String) -> Digest:
  Merkle.digest(Leaf{"file-text-utf8", text})

def Key.compiler(files: Digest, hash_library: Digest) -> Digest:
  Merkle.digest(Fork{
    "compiler",
    "bend-2-book-state-v1",
    Leaf{"digest", Digest.hex(files)},
    Leaf{"digest", Digest.hex(hash_library)}
  })

# Named boundary inputs
# ---------------------

def Key.named_input(role: String, path: String, content: Digest) -> Digest:
  Merkle.digest(Fork{
    "named-input",
    role,
    Leaf{"path", path},
    Leaf{"digest", Digest.hex(content)}
  })

# Checker load order
# ------------------
#
# The checker loads files in one order and checks each after the files it
# imports. The state after the first k files of an entry's load order is keyed
# by P_k = Load.snoc(P_(k-1), Key.step(...)), starting from P_0 = the compiler
# key: a changed, moved or retargeted file changes the chain from its step on.

def Key.step(namespace: String, path: String, content: Digest) -> Digest:
  Merkle.digest(Fork{
    "load-step",
    namespace,
    Leaf{"path", path},
    Leaf{"digest", Digest.hex(content)}
  })

def Load.snoc(prefix: Digest, step: Digest) -> Digest:
  Sequence.snoc("checker-load-order", prefix, step)

# Artifacts
# ---------

def Key.foreign(path: String, content: Digest) -> Digest:
  Merkle.digest(Fork{
    "foreign-input",
    path,
    Leaf{"digest", Digest.hex(content)},
    Empty{}
  })

# An artifact is the final checked state, the target, and the foreign files
# the checked records name (their bytes are embedded by the emitters).
def Key.artifact(state: Digest, target: String, foreigns: Digest) -> Digest:
  Merkle.digest(Fork{
    "compiled-artifact",
    target,
    Leaf{"digest", Digest.hex(state)},
    Leaf{"digest", Digest.hex(foreigns)}
  })

# Retention
# ---------

# The name under which a build records what it keeps alive: one record per
# entry and purpose ("check", or an emit target), replaced by each build.
def Key.root(entry: String, purpose: String) -> Digest:
  Merkle.digest(Fork{
    "gc-root",
    purpose,
    Leaf{"path", entry},
    Empty{}
  })
