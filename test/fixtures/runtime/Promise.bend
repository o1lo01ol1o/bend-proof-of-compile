# The host settles this effect asynchronously; Bend owns the continuation.
import Base

def later() -> IO(U32):
  import "./Promise.js"

def main() -> IO(Unit):
  do IO<Unit>:
    value : U32 <- later()
    IO.print(U32.show(value))

#|42
