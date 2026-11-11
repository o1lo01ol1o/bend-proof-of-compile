// Cold equivalence across incremental histories (SPEC-incremental-compilation.md,
// Acceptance). Every step of every history is compared with the pinned
// checker's CLI, byte for byte apart from poc's source position line after a
// rejection: `bend FILE --check-only` against `poc check`,
// and `bend FILE -o OUT.js` against `poc build` (stderr and artifact). The
// cache persists across the steps of a history, and each step runs in a new
// process, so every history is also a restart test.
//
// Environment: POC_APP_JS, POC_BEND2_SOURCE, POC_HASHES_SOURCE and BEND.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withoutPosition } from "../src/compiler.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};
const bend = required("BEND");
required("POC_APP_JS");
required("POC_BEND2_SOURCE");
required("POC_HASHES_SOURCE");
const cli = path.join(import.meta.dir, "..", "src", "cli.ts");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(cmd: string[], cwd: string, env: Record<string, string>): Run {
  const child = Bun.spawnSync({
    cmd,
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, BEND_NO_TELEMETRY: "1" },
  });
  return {
    code: child.exitCode ?? -1,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

// poc's own lines are its host's debug trace and, after a rejection, the
// source position of the term the checker's error points at. The rest is
// the checker's text, byte for byte.
function checkerText(stderr: string): string {
  return withoutPosition(stderr.split("\n").filter((line) => !line.startsWith("[poc-host] ")).join("\n"));
}

// A project directory with its own cache and its own signer (key and
// trusted keys under `config`).
class History {
  readonly root: string;
  readonly dir: string;
  readonly cache: string;
  signer: Record<string, string>;
  // Read-only store layers this project reads after its own store.
  layers: string | null = null;

  constructor() {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "poc-acceptance-"));
    this.dir = path.join(this.root, "project");
    this.cache = path.join(this.root, "cache");
    fs.mkdirSync(this.dir);
    fs.mkdirSync(this.cache, { mode: 0o700 });
    this.signer = { XDG_CONFIG_HOME: path.join(this.root, "config") };
  }

  write(file: string, text: string): void {
    const at = path.join(this.dir, file);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, text);
  }

  poc(args: string[], debug = false): Run {
    return run([process.execPath, cli, ...args], this.dir, {
      TMPDIR: this.cache,
      POC_DEBUG: debug ? "1" : "0",
      ...(this.layers === null ? {} : { POC_STORE_PATH: this.layers }),
      ...this.signer,
    });
  }

  // This project's own (writable) store.
  store(): string {
    return path.join(this.cache, "bend-proof-of-compile", "v5");
  }

  // The step agrees with a cold check and a cold emit; the result is the
  // check's debug trace (how the check resumed).
  agree(entry: string): string {
    const cold = run([bend, entry, "--check-only"], this.dir, {});
    const traced = this.poc(["check", entry], true);
    const trace = traced.stderr.split("\n").filter((line) => line.startsWith("[poc-host] ")).join("\n");
    const poc = { ...traced, stderr: checkerText(traced.stderr) };
    expect({ entry, code: poc.code, stdout: poc.stdout, stderr: poc.stderr })
      .toEqual({ entry, code: cold.code, stdout: cold.stdout, stderr: cold.stderr });
    if (cold.code === 0 && /^def main\b/m.test(fs.readFileSync(path.resolve(this.dir, entry), "utf8"))) {
      const coldOut = path.join(this.cache, "cold.js");
      const pocOut = path.join(this.cache, "poc.js");
      fs.rmSync(coldOut, { force: true });
      fs.rmSync(pocOut, { force: true });
      const coldEmit = run([bend, entry, "-o", coldOut], this.dir, {});
      const pocEmit = this.poc(["build", entry, "--output", pocOut, "--target", "js"]);
      expect({ code: pocEmit.code, stderr: checkerText(pocEmit.stderr) }).toEqual({ code: coldEmit.code, stderr: coldEmit.stderr });
      expect(fs.readFileSync(pocOut, "utf8")).toBe(fs.readFileSync(coldOut, "utf8"));
    }
    return trace;
  }
}

const P = `import Base

law L:
  Nat

def base_value() -> Nat:
  2n
`;

const M = (body: string): string => `import Base
import ./P.bend as Q

def Q.L():
  ${body}

def middle() -> Nat:
  Nat.add(Q.L(), Q.base_value())
`;

const E = (message: string): string => `import Base
import ./M.bend as R

def main() -> IO(Unit):
  IO.print("${message} " ++ Nat.show(R.middle()))
`;

// A project for `poc unreached`: a live chain through a template instance
// and a constructor, a dead def, type and law, a law about live code with a
// helper only it uses, an unreached def in the entry and an unloaded file.
const LIB = `import Base

type Shape is Data:
  Dot{}
  Box{n: Nat}

type Unused is Data:
  Nope{}

def double(+n: Nat) -> Nat:
  Nat.add(n, n)

def triple(+n: Nat) -> Nat:
  Nat.add(n, Nat.add(n, n))

def scale(~k: Nat, n: Nat) -> Nat:
  Nat.mul(k, n)

def size(s: Shape) -> Nat:
  match s:
    case Dot{}:
      0n
    case Box{n}:
      n

def two() -> Nat:
  2n

law double_two:
  {double(1n) == two() : Nat}

def double_two(): {==}

law triple_one:
  {triple(1n) == 3n : Nat}

def triple_one(): {==}
`;

const MAIN = `import Base
import ./Lib.bend as L

def go(+n: Nat) -> Nat:
  Nat.add(L.double(n), L.scale(3n, L.size(L.Box{n})))

def spare(n: Nat) -> Nat:
  n

def main() -> Nat:
  go(2n)
`;

const EXTRA = `import Base

def orphan() -> Nat:
  1n
`;

describe("incremental histories agree with cold checks", () => {
  test("explicit unsafe checking preserves strict certification across restored states", () => {
    const h = new History();
    h.write("Unsafe.bend", "import Base\n\n@unsafe\ndef assumed(a: Nat) -> Nat:\n  a\n");
    h.write("E.bend", "import Base\nimport ./Unsafe.bend as U\n\ndef result() -> Nat:\n  U.assumed(1n)\n");
    const compare = (allowUnsafe: boolean): Run & { trace: string } => {
      const flags = allowUnsafe ? ["--allow-unsafe"] : [];
      const cold = run([bend, "E.bend", "--check-only", ...flags], h.dir, {});
      const result = h.poc(["check", ...flags, "E.bend"], true);
      const stderr = checkerText(result.stderr);
      expect({ code: result.code, stdout: result.stdout, stderr }).toEqual(cold);
      return { ...result, stderr, trace: result.stderr };
    };
    const permitted = compare(true);
    expect(permitted.code).toBe(0);
    expect(permitted.stdout).toContain("ALL TERMS CHECK\nNot an assumption-free proof verdict.");
    expect(permitted.stdout).toContain("Assumes @unsafe:");
    expect(permitted.stdout).not.toContain("ALL PROOFS CHECK");
    const strict = compare(false);
    expect(strict.code).toBe(1);
    expect(strict.stderr).toContain("SOME PROOFS FAIL");
    expect(strict.trace).not.toContain("bookCheck");
    expect(compare(true).trace).not.toContain("bookCheck");
    h.write("ImportE.bend", "import Base\nimport ./E.bend as E\n");
    const coldModule = run([bend, "ImportE.bend", "--check-only", "--allow-unsafe"], h.dir, {});
    for (const flags of [["--module", "--allow-unsafe"], ["--allow-unsafe", "--module"]]) {
      expect(h.poc(["check", ...flags, "E.bend"])).toEqual(coldModule);
    }
    expect(run([bend, "E.bend", "--check-only", "--allow-unsafe", "--verdict"], h.dir, {}).code).toBe(1);
  }, 900_000);

  test("unsafe checking does not permit foreign assumptions or open laws", () => {
    const h = new History();
    for (const [entry, source] of [
      ["Foreign.bend", 'import Base\n\ndef assumed() -> IO(U32):\n  import "./foreign.js"\n'],
      ["Open.bend", "import Base\n\nlaw missing:\n  Nat\n"],
    ] as const) {
      h.write(entry, source);
      h.write("foreign.js", "function assumed() { return 1; }\n");
      const cold = run([bend, entry, "--check-only", "--allow-unsafe"], h.dir, {});
      const poc = h.poc(["check", "--allow-unsafe", entry]);
      expect(poc).toEqual(cold);
      expect(poc.code).toBe(1);
      expect(poc.stderr).toContain("SOME PROOFS FAIL");
      expect(poc.stderr).toContain(entry === "Foreign.bend" ? "foreign effects" : "1 TODO found.");
    }
  }, 900_000);
  test("entry edit, final-module edit, failed extension, branch from an old state", () => {
    const h = new History();
    h.write("P.bend", P);
    h.write("M.bend", M("5n"));
    h.write("E.bend", E("one"));
    expect(h.agree("E.bend")).toContain("resumePrefix miss");

    h.write("E.bend", E("two"));
    expect(h.agree("E.bend")).toContain("resumePrefix rank=0 remainingGroups=1 remainingSteps=1");

    h.write("M.bend", M("7n"));
    expect(h.agree("E.bend")).toContain("remainingSteps=2");

    // A failed extension: the module no longer checks, then is fixed again.
    h.write("M.bend", M('"not a Nat"'));
    h.agree("E.bend");
    h.write("M.bend", M("7n"));
    expect(h.agree("E.bend")).not.toContain("bookCheck");

    // A branch back to an old state: every state of that history is stored.
    h.write("M.bend", M("5n"));
    h.write("E.bend", E("one"));
    expect(h.agree("E.bend")).not.toContain("bookCheck");
  }, 900_000);

  test("a long sealed history survives suffix edits and branching after restart", () => {
    const h = new History();
    for (let index = 0; index < 32; index++) {
      h.write(`D${index}.bend`, index === 0
        ? "import Base\n\ndef value() -> Nat:\n  0n\n"
        : `import Base\nimport ./D${index - 1}.bend as Prev\n\ndef value() -> Nat:\n  Nat.add(Prev.value(), 1n)\n`);
    }
    const entry = (label: string) => `import Base\nimport ./D31.bend as D\n\ndef main() -> IO(Unit):\n  IO.print("${label} " ++ Nat.show(D.value()))\n`;
    h.write("E.bend", entry("original"));
    expect(h.agree("E.bend")).toContain("resumePrefix miss");
    h.write("E.bend", entry("suffix"));
    expect(h.agree("E.bend")).toContain("remainingSteps=1");
    h.write("D16.bend", "import Base\nimport ./D15.bend as Prev\n\ndef value() -> Nat:\n  Nat.add(Prev.value(), 2n)\n");
    // D0–D15 remain reusable; D16–D31 and the entry form the 17-step suffix.
    expect(h.agree("E.bend")).toContain("resumePrefix rank=16 remainingGroups=17 remainingSteps=17");
    h.write("D16.bend", "import Base\nimport ./D15.bend as Prev\n\ndef value() -> Nat:\n  Nat.add(Prev.value(), 1n)\n");
    h.write("E.bend", entry("original"));
    expect(h.agree("E.bend")).not.toContain("bookCheck");
  }, 900_000);

  test("a law filled by a later file, and prefixes that leave a law open or a hole", () => {
    const h = new History();
    h.write("P.bend", P);
    h.write("Open.bend", `import Base
import ./P.bend as Q

def main() -> IO(Unit):
  IO.print(Nat.show(Q.base_value()))
`);
    h.agree("Open.bend");
    h.write("Hole.bend", `import Base

def gap() -> Nat:
  ?todo
`);
    h.write("UsesHole.bend", `import Base
import ./Hole.bend as H
import ./P.bend as Q

def Q.L():
  1n

def main() -> IO(Unit):
  IO.print("hole below")
`);
    h.agree("UsesHole.bend");

    // Since Bend 2.0.27, every filled non-Base law is a claim of the
    // entry, including a fill in an imported file that the entry never names.
    h.write("UnsafeLaws.bend", `import Base

law danger:
  Nat
`);
    h.write("UnsafeFill.bend", `import Base
import ./UnsafeLaws.bend as Laws

@unsafe
def Laws.danger():
  0n
`);
    h.write("UnsafeEntry.bend", `import Base
import ./UnsafeFill.bend as Fill

def main() -> IO(Unit):
  IO.print("unsafe imported law")
`);
    h.agree("UnsafeEntry.bend");

    h.write("M.bend", M("5n"));
    h.write("E.bend", E("filled"));
    h.agree("E.bend");
    h.write("E.bend", E("filled again"));
    expect(h.agree("E.bend")).toContain("resumePrefix rank=0");
  }, 900_000);

  test("a symlink retarget and a LAWS.bend appearance", () => {
    const h = new History();
    h.write("v1/Lib.bend", "import Base\n\ndef lib() -> Nat:\n  1n\n");
    h.write("v2/Lib.bend", "import Base\n\ndef lib() -> Nat:\n  2n\n");
    fs.symlinkSync("v1", path.join(h.dir, "current"));
    h.write("Main.bend", `import Base
import ./current/Lib.bend as Lib

def main() -> IO(Unit):
  IO.print(Nat.show(Lib.lib()))
`);
    h.agree("Main.bend");
    fs.rmSync(path.join(h.dir, "current"));
    fs.symlinkSync("v2", path.join(h.dir, "current"));
    expect(h.agree("Main.bend")).toContain("bookCheck");

    h.write("PROOF.bend", "import Base\n\ndef main() -> IO(Unit):\n  IO.print(\"proof\")\n");
    h.agree("PROOF.bend");
    h.write("LAWS.bend", "import Base\n");
    h.agree("PROOF.bend");
    h.write("PROOF.bend", "import Base\nimport ./LAWS.bend as LAWS\n\ndef main() -> IO(Unit):\n  IO.print(\"proof\")\n");
    h.agree("PROOF.bend");
  }, 900_000);

  test("restart: seal in one process, restore in another, restore independently in a third", () => {
    const h = new History();
    h.write("P.bend", P);
    h.write("M.bend", M("5n"));
    h.write("E.bend", E("sealed"));
    h.agree("E.bend");
    h.write("E.bend", E("restored"));
    expect(h.agree("E.bend")).toContain("resumePrefix rank=0");
    // A second entry over the same prefix restores the shared states.
    h.write("F.bend", `import Base
import ./M.bend as R

def main() -> IO(Unit):
  IO.print(Nat.show(R.middle()))
`);
    expect(h.agree("F.bend")).toContain("resumePrefix rank=0 remainingGroups=1 remainingSteps=1");
    expect(h.poc(["cache", "verify"]).stdout).toContain('"quarantined":0');
  }, 900_000);

  // Another project's store, read as a layer, serves its states and
  // artifacts without a check or a write; an edit extends the layer's prefix
  // into the reader's own store. Keys name files by real path, so the reader
  // checks the same files (in Nix: the same source store path). A layer is
  // trusted by provenance: a reader with its own signer reads it too.
  test("a read-only store layer serves states and artifacts", () => {
    const base = new History();
    base.write("P.bend", P);
    base.write("M.bend", M("5n"));
    base.write("E.bend", E("layered"));
    base.agree("E.bend");
    const entry = path.join(base.dir, "E.bend");
    const over = new History();
    over.signer = base.signer;
    over.layers = base.store();
    expect(over.agree(entry)).not.toContain("bookCheck");
    expect(fs.existsSync(path.join(over.store(), "objects"))).toBe(false);
    base.write("E.bend", E("edited"));
    expect(over.agree(entry)).toContain("resumePrefix rank=0 remainingGroups=1 remainingSteps=1");
    expect(fs.existsSync(path.join(over.store(), "objects"))).toBe(true);
    expect(over.poc(["cache", "verify"]).stdout).toContain('"quarantined":0');
    // Two layers, searched in order: the edited entry's state is in the second.
    const stranger = new History();
    stranger.layers = [base.store(), over.store()].join(path.delimiter);
    expect(stranger.agree(entry)).not.toContain("bookCheck");
    expect(fs.existsSync(path.join(stranger.store(), "objects"))).toBe(false);
  }, 900_000);

  // `poc plan` prints the load order a chain of boundaries follows: one step
  // per line as "namespace<TAB>realpath", Base first, the entry last.
  test("plan prints the load order, as an entry and as a module", () => {
    const h = new History();
    h.write("P.bend", P);
    h.write("M.bend", M("5n"));
    h.write("E.bend", E("planned"));
    const dir = fs.realpathSync(h.dir);
    const entry = h.poc(["plan", "E.bend"]);
    expect(entry.code).toBe(0);
    const lines = entry.stdout.trimEnd().split("\n");
    expect(lines.length).toBe(4);
    expect(lines[0]).toMatch(/^\t.*\/base\.bend$/);
    expect(lines.slice(1)).toEqual([`P\t${dir}/P.bend`, `M\t${dir}/M.bend`, `\t${dir}/E.bend`]);
    const module = h.poc(["plan", "--module", "M.bend"]);
    expect(module.code).toBe(0);
    expect(module.stdout.trimEnd().split("\n").slice(1)).toEqual([`P\t${dir}/P.bend`, `M\t${dir}/M.bend`]);
    expect(h.poc(["plan"]).code).not.toBe(0);
  }, 120_000);

  test("every independent error of the failing file, cold and resumed, and none past it", () => {
    const h = new History();
    h.write("P.bend", P);
    // Two independent errors in M (the fill of Q.L and other); middle names
    // the failed fill, so it is not checked; E's error is never reached.
    h.write("M.bend", M('"not a Nat"') + `
def other() -> U32:
  5n
`);
    h.write("E.bend", E("one") + `
def broken() -> Nat:
  "never checked"
`);
    for (let round = 0; round < 2; round += 1) {
      h.agree("E.bend");
      const checked = h.poc(["check", "E.bend"]);
      expect(checked.code).not.toBe(0);
      expect(checked.stderr).toContain("Found 2 errors. 1 def that names a failed def was not checked.");
      expect(checked.stderr.match(/^At: M\.bend:\d+:\d+/gm)?.length).toBe(2);
      expect(checked.stderr).not.toContain("broken");
    }
  }, 900_000);

  test("unreached: the definitions under a directory a def does not reach", () => {
    const h = new History();
    h.write("src/Lib.bend", LIB);
    h.write("src/Main.bend", MAIN);
    h.write("src/sub/Extra.bend", EXTRA);
    const report = `unreached from main: 4 of 12 definitions under src
src/Lib.bend
  type Unused
  def triple
  law triple_one
src/Main.bend
  def spare
not loaded by src/Main.bend:
  src/sub/Extra.bend
reached only by laws about reached code:
src/Lib.bend
  def two (kept by law double_two)
`;
    const cold = h.poc(["unreached", "src/Main.bend", "main", "src"], true);
    expect({ code: cold.code, stdout: cold.stdout }).toEqual({ code: 0, stdout: report });
    expect(cold.stderr).toContain("bookCheck");
    // A second run reads the stored state: nothing is checked again.
    const warm = h.poc(["unreached", "src/Main.bend", "main", "src"], true);
    expect({ code: warm.code, stdout: warm.stdout }).toEqual({ code: 0, stdout: report });
    expect(warm.stderr).not.toContain("bookCheck");
    // As a module, the def is spelled as the module spells it.
    const module = h.poc(["unreached", "--module", "src/Lib.bend", "double", "src"]);
    expect(module.code).toBe(0);
    expect(module.stdout).toContain("def triple");
    expect(module.stdout).toContain("src/Main.bend");
    const missing = h.poc(["unreached", "src/Main.bend", "nowhere", "src"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("no definition nowhere in src/Main.bend");
  }, 900_000);

  test("C from a restored state: a module's foreign C names its own module's ids", () => {
    const h = new History();
    // tick's C resolves CID(tick) and CID(tock) in M's namespace, which a
    // restored record must keep (pack schema 9); tock is never called.
    h.write("M.bend", `import Base

def tick(n: U32) -> IO(U32):
  import "./tick.c"

def tock(n: U32) -> IO(U32):
  import "./tick.c"
`);
    h.write("tick.c", `static Term tick_run(Env e, Term* f, IoWork* w) {
  return f[0];
}

static void __attribute__((constructor)) tick_use(void) {
#ifdef CID(tick)
  io_eff(CID(tick), tick_run);
#endif
#ifdef CID(tock)
  io_eff(CID(tock), tick_run);
#endif
}
`);
    h.write("E.bend", `import Base
import ./M.bend as M

def main() -> IO(Unit):
  do IO<Unit>:
    v : U32 <- M.tick(7)
    IO.print(U32.show(v))
`);
    // The check commits the final state (its verdict refuses the foreign
    // code); the build then emits from that state, restored.
    expect(h.poc(["check", "--allow-unsafe", "E.bend"]).stderr).toContain("rely on unsafe or foreign code");
    const coldOut = path.join(h.cache, "cold.c");
    const pocOut = path.join(h.cache, "poc.c");
    const cold = run([bend, "E.bend", "-o", coldOut], h.dir, {});
    const built = h.poc(["build", "E.bend", "--output", pocOut, "--target", "c"], true);
    expect(built.stderr).not.toContain("bookCheck");
    expect({ code: built.code, stderr: checkerText(built.stderr) }).toEqual({ code: cold.code, stderr: cold.stderr });
    expect(fs.readFileSync(pocOut, "utf8")).toBe(fs.readFileSync(coldOut, "utf8"));
  }, 900_000);

  test("signed states: forgeries are quarantined, untrusted signers are misses", () => {
    const h = new History();
    h.write("P.bend", P);
    h.write("M.bend", M("5n"));
    h.write("E.bend", E("signed"));
    h.agree("E.bend");
    const objects = path.join(h.store(), "objects");
    const metas = (): string[] => fs.readdirSync(objects).flatMap((bucket) =>
      fs.readdirSync(path.join(objects, bucket))
        .filter((name) => !name.includes(".tmp-"))
        .map((name) => path.join(objects, bucket, name, "meta.json")));

    // A forger without the key rewrites a state's payload and its digest.
    const target = metas().find((meta) => JSON.parse(fs.readFileSync(meta, "utf8")).kind === "state");
    if (target === undefined) {
      throw new Error("no state was stored");
    }
    const metadata = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
    const payload = path.join(path.dirname(target), "state.bin");
    const forged = Buffer.concat([fs.readFileSync(payload), Buffer.from([0])]);
    fs.writeFileSync(payload, forged);
    metadata.bytes = forged.byteLength;
    metadata.payloadSha256 = new Bun.CryptoHasher("sha256").update(forged).digest("hex");
    fs.writeFileSync(target, JSON.stringify(metadata));
    const verified = JSON.parse(h.poc(["cache", "verify"]).stdout) as { quarantined: number; failures: string[] };
    expect(verified.quarantined).toBe(1);
    expect(verified.failures.join("\n")).toContain("signature does not verify");
    h.agree("E.bend");

    // A second signer whose trusted keys omit the first: every stored object
    // is a miss, the check runs again, and its objects replace them.
    const first = { ...h.signer };
    h.signer = {
      POC_SIGNING_KEY: path.join(h.root, "other", "key.pem"),
      POC_TRUSTED_KEYS: path.join(h.root, "other", "trusted"),
    };
    expect(h.agree("E.bend")).toContain("resumePrefix miss");
    expect(h.agree("E.bend")).not.toContain("bookCheck");

    // Trusting the second signer's key makes its states the first's too.
    const second = h.poc(["cache", "status"]);
    expect(second.code).toBe(0);
    const otherKey = run([process.execPath, path.join(import.meta.dir, "..", "src", "signer.ts"), "public"], h.dir, h.signer).stdout.trim();
    h.signer = first;
    run([process.execPath, path.join(import.meta.dir, "..", "src", "signer.ts"), "trust", otherKey], h.dir, h.signer);
    expect(h.agree("E.bend")).not.toContain("bookCheck");
    const final = JSON.parse(h.poc(["cache", "verify"]).stdout) as { quarantined: number; untrusted: number };
    expect(final).toMatchObject({ quarantined: 0, untrusted: 0 });
  }, 900_000);

  test("modules checked bottom-up are the prefixes their importers resume from", () => {
    const h = new History();
    h.write("P.bend", P);
    h.write("M.bend", `import Base
import ./P.bend as Q

def Q.L():
  5n

def middle() -> Nat:
  Nat.add(Q.L(), Q.base_value())
`);
    h.write("E.bend", `import Base
import ./P.bend as Q
import ./M.bend as R

def main() -> IO(Unit):
  IO.print(Nat.show(R.middle()))
`);
    const traced = (args: string[]): Run & { trace: string } => {
      const result = h.poc(args, true);
      return { ...result, trace: result.stderr };
    };
    // A module's verdict is the checker's on a sibling root that imports it.
    const asImported = (file: string): Run => {
      const name = file.replace(/\.bend$/, "");
      h.write(`Root${name}.bend`, `import ./${file} as ${name}\n`);
      return run([bend, `Root${name}.bend`, "--check-only"], h.dir, {});
    };
    const p = traced(["check", "--module", "P.bend"]);
    expect(p.trace).toContain("resumePrefix miss");
    expect({ code: p.code, stdout: p.stdout }).toEqual({ code: asImported("P.bend").code, stdout: asImported("P.bend").stdout });
    const m = traced(["check", "--module", "M.bend"]);
    expect(m.trace).toContain("resumePrefix rank=0 remainingGroups=1 remainingSteps=1");
    expect({ code: m.code, stdout: m.stdout }).toEqual({ code: asImported("M.bend").code, stdout: asImported("M.bend").stdout });
    expect(h.agree("E.bend")).toContain("resumePrefix rank=0 remainingGroups=1 remainingSteps=1");

    // A module that does not check fails as the checker fails on it imported.
    h.write("Bad.bend", "import Base\n\ndef oops() -> Nat:\n  \"text\"\n");
    const bad = traced(["check", "--module", "Bad.bend"]);
    const cold = asImported("Bad.bend");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("\nAt: Bad.bend:4:3-8\n");
    expect(checkerText(bad.stderr)).toBe(cold.stderr);
  }, 900_000);
});

