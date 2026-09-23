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

// A project directory with its own cache and its own signer (key and
// trusted keys under `config`).
class History {
  readonly root: string;
  readonly dir: string;
  readonly cache: string;
  signer: Record<string, string>;

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
      ...this.signer,
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
  }, 900_000);

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
import ./M.bend as M

def main() -> IO(Unit):
  IO.print(Nat.show(M.middle()))
`);
    expect(h.agree("F.bend")).toContain("resumePrefix rank=0 remainingGroups=1 remainingSteps=1");
    expect(h.poc(["cache", "verify"]).stdout).toContain('"quarantined":0');
  }, 900_000);

  test("signed states: forgeries are quarantined, untrusted signers are misses", () => {
    const h = new History();
    h.write("P.bend", P);
    h.write("M.bend", M("5n"));
    h.write("E.bend", E("signed"));
    h.agree("E.bend");
    const objects = path.join(h.cache, "bend-proof-of-compile", "v3", "objects");
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
import ./P.bend as P

def P.L():
  5n

def middle() -> Nat:
  Nat.add(P.L(), P.base_value())
`);
    h.write("E.bend", `import Base
import ./P.bend as P
import ./M.bend as M

def main() -> IO(Unit):
  IO.print(Nat.show(M.middle()))
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
    expect(bad.stderr.split("\n").filter((line) => !line.startsWith("[poc-host] ")).join("\n")).toBe(cold.stderr);
  }, 900_000);
});

