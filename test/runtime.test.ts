// Exercise the upstream scheduler directly, without the POC capability host.
// These are valid foreign-effect outcomes, not altered checker verdicts.
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCompiler } from "../src/compiler.ts";

const source = process.env.POC_BEND2_SOURCE;
if (source === undefined) throw new Error("POC_BEND2_SOURCE is required");
const runtime = await loadCompiler(source);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "poc-runtime-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const outputs = new Map<string, string>();
for (const name of ["Promise", "Mixed", "MixedSocket"]) {
  const state = await runtime.bookRead(path.join(import.meta.dir, "fixtures", "runtime", `${name}.bend`));
  const output = path.join(scratch, `${name}.js`);
  fs.writeFileSync(output, runtime.emit(state.book, "js"));
  outputs.set(name, output);
}

function run(name: string, mode = "promise", executable = process.execPath) {
  const output = outputs.get(name);
  if (output === undefined) throw new Error(`missing ${name}`);
  const child = Bun.spawnSync({
    cmd: [executable, output],
    env: { ...process.env, POC_RUNTIME_CASE: mode },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

for (const mode of ["promise", "thenable", "sync"]) {
  test(`${mode} effect resumes its continuation exactly once`, () => {
    expect(run("Promise", mode)).toEqual({ code: 0, stdout: "42\n", stderr: "" });
  });
}

test("Promise rejection reaches the executable error boundary", () => {
  const result = run("Promise", "reject");
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("host rejected effect");
});

test("undefined is not an asynchronous effect value", () => {
  const result = run("Promise", "undefined");
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("a Promise effect returned undefined");
});

test("Promise effects coexist with native timer waits and fork/join", () => {
  expect(run("Mixed")).toEqual({ code: 0, stdout: "42\n", stderr: "" });
});

test("Promise completion wakes a scheduler waiting on a native socket", () => {
  expect(run("MixedSocket")).toEqual({ code: 0, stdout: "42\n", stderr: "" });
});

const node = Bun.which("node");
test.skipIf(node === null)("Promise-only scheduling does not require bun:ffi on Node", () => {
  expect(run("Promise", "promise", node!)).toEqual({ code: 0, stdout: "42\n", stderr: "" });
});
