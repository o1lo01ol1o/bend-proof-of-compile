# A recursive polymorphic definition instantiated at List<&2, U32>: the
# case whose checked body an empty-environment raise once compiled wrongly
# (F1), because its annotation types hold checker variables.
import Base

def len(A: Data, xs: List<&2, A>) -> U32:
  match xs:
    case Nil{}:
      0
    case _ <> rest:
      U32.add(1, len(A, rest))

def main() -> IO(Unit):
  IO.print(U32.show(len(U32, [1, 2, 3])))

#|3
