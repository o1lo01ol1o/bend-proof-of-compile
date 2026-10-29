# Promise completion and native timer completion share Bend's fork/join.
import Base
import ./Promise.bend as P

def main() -> IO(Unit):
  do IO<Unit>:
    answer : Chan(U32) <- IO.fork(U32, P.later())
    Unit <- IO.sleep(1)
    value : U32 <- IO.join(U32, answer)
    IO.print(U32.show(value))

#|42
