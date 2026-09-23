import Base
import ../../../vendor/bend-hashes/sha2_32.bend as H

def Sha.s256(s: String) -> String:
  H.SHA256.text(s)

def Sha.s224(s: String) -> String:
  H.SHA224.text(s)

def Sha.b256(xs: List<&2, U32>) -> String:
  H.SHA256.hex_bytes(xs)

def Sha.b224(xs: List<&2, U32>) -> String:
  H.SHA224.hex_bytes(xs)
