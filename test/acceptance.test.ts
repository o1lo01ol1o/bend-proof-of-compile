// Cold equivalence across incremental histories (SPEC-incremental-compilation.md,
// Acceptance). Every step of every history is compared with the pinned
// checker's CLI, byte for byte: `bend FILE --check-only` against `poc check`,
// and `bend FILE -o OUT.js` against `poc build` (stderr and artifact). The
// cache persists across the steps of a history, and each step runs in a new
// process, so every history is also a restart test.
//
// Environment: POC_APP_LIB, POC_BEND2_SOURCE, POC_HASHES_SOURCE and BEND.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};
const bend = required("BEND");
required("POC_APP_LIB");
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

// A project directory with its own private cache.
class History {
  readonly dir: string;
  readonly cache: string;

  constructor() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "poc-acceptance-"));
    this.dir = path.join(root, "project");
    this.cache = path.join(root, "cache");
    fs.mkdirSync(this.dir);
    fs.mkdirSync(this.cache, { mode: 0o700 });
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
    });
  }

  // The step agrees with a cold check and a cold emit; the result is the
  // check's debug trace (how the check resumed).
  agree(entry: string): string {
    const cold = run([bend, entry, "--check-only"], this.dir, {});
    const traced = this.poc(["check", entry], true);
    const trace = traced.stderr.split("\n").filter((line) => line.startsWith("[poc-host] ")).join("\n");
    const poc = { ...traced, stderr: traced.stderr.split("\n").filter((line) => !line.startsWith("[poc-host] ")).join("\n") };
    expect({ entry, code: poc.code, stdout: poc.stdout, stderr: poc.stderr })
      .toEqual({ entry, code: cold.code, stdout: cold.stdout, stderr: cold.stderr });
    if (cold.code === 0 && /^def main\b/m.test(fs.readFileSync(path.join(this.dir, entry), "utf8"))) {
      const coldOut = path.join(this.cache, "cold.js");
      const pocOut = path.join(this.cache, "poc.js");
      fs.rmSync(coldOut, { force: true });
      fs.rmSync(pocOut, { force: true });
      const coldEmit = run([bend, entry, "-o", coldOut], this.dir, {});
      const pocEmit = this.poc(["build", entry, "--output", pocOut, "--target", "js"]);
      expect({ code: pocEmit.code, stderr: pocEmit.stderr }).toEqual({ code: coldEmit.code, stderr: coldEmit.stderr });
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
import ./P.bend as P

def P.L():
  ${body}

def middle() -> Nat:
  Nat.add(P.L(), P.base_value())
`;

const E = (message: string): string => `import Base
import ./M.bend as M

def main() -> IO(Unit):
  IO.print("${message} " ++ Nat.show(M.middle()))
`;

describe("incremental histories agree with cold checks", () => {
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
  }, 120_000);

  test("a law filled by a later file, and prefixes that leave a law open or a hole", () => {
    const h = new History();
    h.write("P.bend", P);
    h.write("Open.bend", `import Base
import ./P.bend as P

def main() -> IO(Unit):
  IO.print(Nat.show(P.base_value()))
`);
    h.agree("Open.bend");
    h.write("Hole.bend", `import Base

def gap() -> Nat:
  ?todo
`);
    h.write("UsesHole.bend", `import Base
import ./Hole.bend as H
import ./P.bend as P

def P.L():
  1n

def main() -> IO(Unit):
  IO.print("hole below")
`);
    h.agree("UsesHole.bend");
    h.write("M.bend", M("5n"));
    h.write("E.bend", E("filled"));
    h.agree("E.bend");
    h.write("E.bend", E("filled again"));
    expect(h.agree("E.bend")).toContain("resumePrefix rank=0");
  }, 120_000);

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
  }, 120_000);

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
import ./M.bend as M

def main() -> IO(Unit):
  IO.print(Nat.show(M.middle()))
`);
    expect(h.agree("F.bend")).toContain("resumePrefix rank=0 remainingGroups=1 remainingSteps=1");
    expect(h.poc(["cache", "verify"]).stdout).toContain('"quarantined":0');
  }, 120_000);
});
