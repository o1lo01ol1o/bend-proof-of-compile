# The listener must wait on a native descriptor while the client awaits a Promise.
import Base
import ./Promise.bend as P

def connect(port: U32) -> IO(Unit):
  do IO<Unit>:
    value : U32 <- P.later()
    socket : Socket <- IO.try(Socket, TCP.connect("127.0.0.1", port))
    Unit <- Socket.close(socket)
    IO.print(U32.show(value))

def accepted(worker: Chan(Unit), result: Listener & Result<&1, &1, (U32 & String), Socket>) -> IO(Unit):
  (listener, answer) = result
  do IO<Unit>:
    socket : Socket <- IO.pass(Socket, answer)
    Unit <- Socket.close(socket)
    Unit <- Listener.close(listener)
    IO.join(Unit, worker)

def serve(bound: Listener & U32) -> IO(Unit):
  (listener, port) = bound
  do IO<Unit>:
    worker : Chan(Unit) <- IO.fork(Unit, connect(port))
    result : Listener & Result<&1, &1, (U32 & String), Socket> <- TCP.accept(listener)
    accepted(worker, result)

def retry(port: U32, answer: Result<&1, &1, (U32 & String), Listener>, rest: IO(Listener & U32)) -> IO(Listener & U32):
  match answer:
    case Done{listener}:
      IO.pure(Listener & U32, (listener, port))
    case Fail{error}:
      rest

law listen_any:
  for tries: Nat
  for +port: U32
  IO(Listener & U32)

def listen_any(tries, port):
  match tries:
    case 0n:
      IO.die(Listener & U32, 1, "no free runtime-test port")
    case 1n+rest:
      fallback = listen_any(rest, (port + 1 : U32))
      do IO<Listener & U32>:
        answer : Result<&1, &1, (U32 & String), Listener> <- TCP.listen("127.0.0.1", port)
        retry(port, answer, fallback)

def main() -> IO(Unit):
  do IO<Unit>:
    bound : Listener & U32 <- listen_any(32n, 29853)
    serve(bound)

#|42
