import Base

# The source grammar is parsed in Bend. Host code only supplies bytes and path
# operations; it does not decide dependency or cache semantics.
type ImportKind is Data:
  ImportBase{}
  ImportHub{}
  ImportLocal{}

type Import is Data:
  Import{kind: ImportKind, specifier: String, alias: String}

type LineImport is Data:
  LineSkip{}
  LineStop{}
  LineBad{message: String}
  LineImport{value: Import}

type ParsedSource is Data:
  ParsedSource{imports: List<&2, Import>, foreigns: List<&2, String>}

# String tokenization
# -------------------

def Source.first(parts: List<&2, String>) -> String:
  match parts:
    case Nil{}:
      SNil{}
    case head <> tail:
      head

def Source.strip_comment(text: String) -> String:
  Source.first(String.split(text, '#'))

def Source.normalize_space(text: String) -> String:
  match text:
    case SNil{}:
      SNil{}
    case SCon{+head, tail}:
      SCon{
        Bool.pick(Char, Char.is_space(head), ' ', head),
        Source.normalize_space(tail)
      }

def Source.nonempty(text: String) -> Bool:
  Bool.not(String.is_empty(text))

def Source.words(text: String) -> List<&2, String>:
  List.filter(
    ~String,
    ~Source.nonempty,
    String.split(Source.normalize_space(text), ' ')
  )

# Import parsing
# --------------

def Source.alias.last(default: String, last: Maybe<&2, String>) -> String:
  match last:
    case None{}:
      default
    case Some{value}:
      value

def Source.default_alias.trimmed(+trimmed: String) -> String:
  Source.alias.last(trimmed, List.last(&2, String, String.split(trimmed, '/')))

def Source.default_alias(+specifier: String) -> String:
  Source.default_alias.trimmed(
    String.take(specifier, Nat.sub(String.length(specifier), 5n))
  )

def Source.kind(+specifier: String) -> ImportKind:
  Bool.pick(
    ImportKind,
    String.eq(specifier, "Base"),
    ImportBase{},
    Bool.pick(
      ImportKind,
      String.starts_with(specifier, "0x"),
      ImportHub{},
      ImportLocal{}
    )
  )

def Source.import.finish(+specifier: String, +alias: String) -> LineImport:
  valid = Bool.or(
    String.eq(specifier, "Base"),
    String.ends_with(specifier, ".bend")
  )
  Bool.pick(
    LineImport,
    valid,
    LineImport{Import{Source.kind(specifier), specifier, alias}},
    LineBad{String.append("import must be Base or end in .bend: ", specifier)}
  )

def Source.import.default(+specifier: String) -> LineImport:
  alias = Bool.pick(
    String,
    String.eq(specifier, "Base"),
    "Base",
    Source.default_alias(specifier)
  )
  Source.import.finish(specifier, alias)

def Source.import.tail(tokens: List<&2, String>) -> LineImport:
  match tokens:
    case specifier <> Nil{}:
      Source.import.default(specifier)
    case specifier <> keyword <> alias <> Nil{}:
      Bool.pick(
        LineImport,
        String.eq(keyword, "as"),
        Source.import.finish(specifier, alias),
        LineBad{"expected `as` in import alias"}
      )
    case _:
      LineBad{"expected `import <module> [as <alias>]`"}

def Source.line.nonempty(tokens: List<&2, String>) -> LineImport:
  match tokens:
    case Nil{}:
      LineSkip{}
    case first <> tail:
      Bool.pick(
        LineImport,
        String.eq(first, "import"),
        Source.import.tail(tail),
        LineStop{}
      )

def Source.line(line: String) -> LineImport:
  Source.line.nonempty(Source.words(String.trim(Source.strip_comment(line))))

def Source.leading.go(
  lines: List<&2, String>,
  reversed: List<&2, Import>,
  parsed: LineImport
) -> Result<&2, &2, String, List<&2, Import>>:
  match lines parsed:
    case Nil{} LineSkip{}:
      Done{List.reverse(&2, Import, reversed)}
    case line <> rest LineSkip{}:
      Source.leading.go(rest, reversed, Source.line(line))
    case _ LineStop{}:
      Done{List.reverse(&2, Import, reversed)}
    case _ LineBad{message}:
      Fail{message}
    case Nil{} LineImport{value}:
      Done{List.reverse(&2, Import, value <> reversed)}
    case line <> rest LineImport{value}:
      Source.leading.go(rest, value <> reversed, Source.line(line))

def Source.leading(lines: List<&2, String>) -> Result<&2, &2, String, List<&2, Import>>:
  Source.leading.go(lines, Nil{}, LineSkip{})

# Foreign implementation imports can occur in definition bodies, so they are
# collected from every line rather than only the leading module-import block.
def Source.foreign.extract(inner: String) -> String:
  String.reverse(String.drop(String.reverse(inner), 1n))

def Source.foreign.valid(+clean: String, starts: Bool) -> Maybe<&2, String>:
  match starts:
    case False{}:
      None{}
    case True{}:
      Bool.pick(
        Maybe<&2, String>,
        String.ends_with(clean, "\""),
        Some{Source.foreign.extract(String.drop(clean, 8n))},
        None{}
      )

def Source.foreign.clean(+clean: String) -> Maybe<&2, String>:
  Source.foreign.valid(clean, String.starts_with(clean, "import \""))

def Source.foreign.candidate(+clean: String, starts: Bool) -> Maybe<&2, String>:
  match starts:
    case False{}:
      None{}
    case True{}:
      Source.foreign.clean(String.trim(Source.strip_comment(clean)))

def Source.foreign.candidate.start(+clean: String) -> Maybe<&2, String>:
  Source.foreign.candidate(clean, String.starts_with(clean, "import \""))

def Source.foreign.line(line: String) -> Maybe<&2, String>:
  Source.foreign.candidate.start(String.trim_start(line))

def Source.foreigns.go(
  lines: List<&2, String>,
  reversed: List<&2, String>,
  found: Maybe<&2, String>
) -> List<&2, String>:
  match lines found:
    case Nil{} None{}:
      List.reverse(&2, String, reversed)
    case line <> rest None{}:
      Source.foreigns.go(rest, reversed, Source.foreign.line(line))
    case Nil{} Some{value}:
      List.reverse(&2, String, value <> reversed)
    case line <> rest Some{value}:
      Source.foreigns.go(rest, value <> reversed, Source.foreign.line(line))

def Source.parse.imports(
  lines: List<&2, String>,
  imports: Result<&2, &2, String, List<&2, Import>>
) -> Result<&2, &2, String, ParsedSource>:
  match imports:
    case Fail{error}:
      Fail{error}
    case Done{value}:
      Done{ParsedSource{value, Source.foreigns.go(lines, Nil{}, None{})}}

def Source.parse_lines(+lines: List<&2, String>) -> Result<&2, &2, String, ParsedSource>:
  Source.parse.imports(lines, Source.leading(lines))

def Source.parse(+text: String) -> Result<&2, &2, String, ParsedSource>:
  Source.parse_lines(String.lines(text))
