// Cold equivalence over a corpus: for every .bend file under the given
// directories, the pinned checker's CLI (`bend FILE --check-only`, and
// `bend FILE -o OUT.js` for files with a main) and this application
// (`poc check FILE`, `poc build FILE --output OUT.js`) must agree byte for
// byte on stdout, stderr, exit status and artifact.
//
//   bun tools/cold-equivalence.ts [--emit] [--jobs N] [--rounds N] (DIR | FILE)...
//
// Environment: POC_APP_LIB, POC_BEND2_SOURCE, POC_HASHES_SOURCE (as for the
// CLI), BEND (the checker's CLI), TMPDIR (the shared cache lives there).
// A second round rechecks every file against the warm cache.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const args = process.argv.slice(2);
let emit = false;
let jobs = Math.max(1, os.availableParallelism() - 2);
let rounds = 1;
const roots: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] as string;
  if (arg === "--emit") {
    emit = true;
  } else if (arg === "--jobs") {
    jobs = Number(args[++index]);
  } else if (arg === "--rounds") {
    rounds = Number(args[++index]);
  } else {
    roots.push(path.resolve(arg));
  }
}
const bend = process.env.BEND ?? "bend";
const cli = path.join(import.meta.dir, "..", "src", "cli.ts");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "poc-equivalence-"));

// Each argument is a .bend file, or a directory searched for them.
const files = roots.flatMap(function walk(root: string): string[] {
  if (!fs.statSync(root).isDirectory()) {
    return [root];
  }
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walk(file) : entry.name.endsWith(".bend") ? [file] : [];
  });
}).sort();

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(cmd: string[], cwd: string): Promise<Run> {
  const child = Bun.spawn({
    cmd,
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BEND_NO_TELEMETRY: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

const same = (a: Run, b: Run): boolean =>
  a.code === b.code && a.stdout === b.stdout && a.stderr === b.stderr;

const failures: string[] = [];
let compared = 0;
let emitted = 0;

async function compare(file: string, round: number): Promise<void> {
  const cwd = path.dirname(file);
  const name = path.basename(file);
  const cold = await run([bend, name, "--check-only"], cwd);
  const poc = await run([process.execPath, cli, "check", name], cwd);
  compared += 1;
  if (!same(cold, poc)) {
    failures.push(`${file} [check, round ${round}]\n  cold ${cold.code}: ${JSON.stringify(cold.stdout + cold.stderr).slice(0, 300)}\n  poc  ${poc.code}: ${JSON.stringify(poc.stdout + poc.stderr).slice(0, 300)}`);
    return;
  }
  if (!emit || cold.code !== 0 || !/^def main\b/m.test(fs.readFileSync(file, "utf8"))) {
    return;
  }
  const id = `${compared}-${path.basename(file, ".bend")}`;
  const coldOut = path.join(scratch, `${id}.cold.js`);
  const pocOut = path.join(scratch, `${id}.poc.js`);
  const coldEmit = await run([bend, name, "-o", coldOut], cwd);
  const pocEmit = await run([process.execPath, cli, "build", name, "--output", pocOut, "--target", "js"], cwd);
  emitted += 1;
  const bytes = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "<none>");
  if (coldEmit.code !== pocEmit.code || coldEmit.stderr !== pocEmit.stderr || bytes(coldOut) !== bytes(pocOut)) {
    failures.push(`${file} [emit js, round ${round}]\n  cold ${coldEmit.code}: ${JSON.stringify(coldEmit.stderr).slice(0, 200)}\n  poc  ${pocEmit.code}: ${JSON.stringify(pocEmit.stderr).slice(0, 200)} artifact ${bytes(coldOut) === bytes(pocOut) ? "same" : "differs"}`);
  }
  fs.rmSync(coldOut, { force: true });
  fs.rmSync(pocOut, { force: true });
}

for (let round = 1; round <= rounds; round += 1) {
  const queue = [...files];
  const started = performance.now();
  await Promise.all(Array.from({ length: jobs }, async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      await compare(file, round);
    }
  }));
  process.stderr.write(`round ${round}: ${files.length} files in ${((performance.now() - started) / 1000).toFixed(0)} s\n`);
}
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`compared ${compared} checks and ${emitted} emits; ${failures.length} disagreements`);
for (const failure of failures) {
  console.log(failure);
}
process.exit(failures.length === 0 ? 0 : 1);
