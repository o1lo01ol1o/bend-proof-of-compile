type Bit is Data:
  O{}
  I{}

def flip(b: Bit) -> Bit:
  match b:
    case O{}:
      I{}
    case I{}:
      O{}

law later: Bit
