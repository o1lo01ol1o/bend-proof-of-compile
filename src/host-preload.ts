import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { decodeBookState, encodeBookState } from "./codec.ts";
import {
  loadCompiler,
  type BookStateLike,
  type CompilerRuntime,
} from "./compiler.ts";

interface NamedBytes {
  readonly path: string;
  readonly bytes: string;
}

interface CasMetadata {
  readonly schema: 1;
  readonly kind: "state" | "artifact";
  readonly key: string;
  readonly payloadSha256: string;
  readonly bytes: number;
}

interface CompileStep {
  readonly file: string;
  readonly namespace: string;
  readonly key: string;
}

interface ResumeCandidate {
  readonly key: string;
  readonly steps: readonly CompileStep[];
}

interface StateStage {
  readonly directory: string;
  readonly entries: Array<{
    readonly cache: string;
    readonly key: string;
    readonly payload: string;
  }>;
  closed: boolean;
}

interface HostApi {
  cacheRoot(namespace: string, version: string): string;
  compilerInputs(): { compiler: readonly NamedBytes[]; hashes: readonly NamedBytes[] };
  defaultBase(): string;
  realpath(file: string): string;
  resolve(owner: string, specifier: string): string;
  readSource(file: string): { text: string; lines: readonly string[]; bytes: string };
  stateGet(cache: string, key: string): BookStateLike | null;
  stateGetLongest(
    cache: string,
    candidates: readonly ResumeCandidate[],
  ): { readonly state: BookStateLike; readonly steps: readonly CompileStep[] } | null;
  stageStart(): StateStage;
  stageCommit(stage: StateStage): void;
  stageAbort(stage: StateStage): void;
  bookReadSuffix(
    cache: string,
    entry: string,
    stateKey: string,
    steps: readonly CompileStep[],
    seed: BookStateLike | undefined,
    stage: StateStage,
  ): { readonly state: BookStateLike; readonly stage: StateStage };
  artifactRestore(cache: string, key: string, output: string): boolean;
  outputRemove(output: string): void;
  artifactBuild(
    cache: string,
    key: string,
    output: string,
    target: string,
    state: BookStateLike,
  ): void;
  cacheStatus(cache: string): object;
  cacheVerify(cache: string): object;
  cacheGc(cache: string, live: readonly string[]): object;
}

declare global {
  // Installed for foreign/host.js, which is embedded in generated Bend code.
  var POC_HOST: HostApi | undefined;
}

const bend2Source = requiredEnvironment("POC_BEND2_SOURCE");
const hashesSource = requiredEnvironment("POC_HASHES_SOURCE");
const runtime = await loadCompiler(bend2Source);
const compilerWorker = fileURLToPath(new URL("./compiler-worker.ts", import.meta.url));
let memoizedInputs:
  | { compiler: readonly NamedBytes[]; hashes: readonly NamedBytes[] }
  | undefined;

globalThis.POC_HOST = {
  cacheRoot(namespace, version) {
    const safeNamespace = safeSegment(namespace);
    const safeVersion = safeSegment(version);
    const root = path.join(os.tmpdir(), safeNamespace, safeVersion);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
  },

  compilerInputs() {
    memoizedInputs ??= {
      compiler: immutableIdentityOrTree(bend2Source),
      hashes: immutableIdentityOrTree(hashesSource),
    };
    return memoizedInputs;
  },

  defaultBase() {
    return runtime.baseFile;
  },

  realpath(file) {
    return fs.realpathSync(path.resolve(file));
  },

  resolve(owner, specifier) {
    return path.resolve(path.dirname(owner), specifier);
  },

  readSource(file) {
    const bytes = fs.readFileSync(file);
    const text = bytes.toString("utf8");
    return { text, lines: text.split("\n"), bytes: bytes.toString("base64") };
  },

  stateGet(cache, key) {
    return readState(cache, key);
  },

  stateGetLongest(cache, candidates) {
    for (const [index, candidate] of candidates.entries()) {
      const state = readState(cache, candidate.key);
      if (state !== null) {
        if (process.env.POC_DEBUG === "1") {
          process.stderr.write(
            `[poc-host] resumePrefix rank=${index} remainingSteps=${candidate.steps.length}\n`,
          );
        }
        return { state, steps: candidate.steps };
      }
    }
    if (process.env.POC_DEBUG === "1") {
      process.stderr.write("[poc-host] resumePrefix miss\n");
    }
    return null;
  },

  stageStart() {
    return {
      directory: fs.mkdtempSync(path.join(os.tmpdir(), "poc-stage-")),
      entries: [],
      closed: false,
    };
  },

  stageCommit(stage) {
    assertOpenStage(stage);
    try {
      for (const entry of stage.entries) {
        putCasObject(
          entry.cache,
          entry.key,
          "state",
          fs.readFileSync(entry.payload),
        );
      }
    } finally {
      closeStage(stage);
    }
  },

  stageAbort(stage) {
    if (!stage.closed) {
      closeStage(stage);
    }
  },

  bookReadSuffix(cache, entry, stateKey, steps, seed, stage) {
    assertOpenStage(stage);
    if (process.env.POC_DEBUG === "1") {
      process.stderr.write(
        `[poc-host] compileSuffix steps=${steps.length} seeded=${seed !== undefined}\n`,
      );
    }
    try {
      let state = seed;
      for (const step of steps) {
        const checked = runBookRead(step.file, step.namespace, state);
        state = { book: checked.book, seen: checked.seen };
        stageState(stage, cache, step.key, state);
      }
      const checked = runBookRead(entry, "", state);
      const finalState = { book: checked.book, seen: checked.seen };
      stageState(stage, cache, stateKey, finalState);
      return { state: finalState, stage };
    } catch (error) {
      if (!stage.closed) {
        closeStage(stage);
      }
      throw error;
    }
  },

  artifactRestore(cache, key, output) {
    assertDigest(key);
    try {
      const payload = readCasObject(cache, key, "artifact");
      if (payload === null) {
        return false;
      }
      atomicWrite(path.resolve(output), payload);
      return true;
    } catch (error) {
      quarantine(cache, key, error);
      return false;
    }
  },

  outputRemove(output) {
    fs.rmSync(path.resolve(output), { force: true });
  },

  artifactBuild(cache, key, output, target, state) {
    assertDigest(key);
    const source = target === "js"
      ? runtime.compileJs(state.book)
      : target === "c"
        ? runtime.compileC(state.book)
        : fail(`unsupported target: ${target}`);
    const payload = Buffer.from(source, "utf8");
    putCasObject(cache, key, "artifact", payload);
    atomicWrite(path.resolve(output), payload);
  },

  cacheStatus(cache) {
    const objects = enumerateObjects(cache);
    return {
      root: cache,
      objects: objects.length,
      states: objects.filter((item) => item.kind === "state").length,
      artifacts: objects.filter((item) => item.kind === "artifact").length,
      bytes: objects.reduce((total, item) => total + item.bytes, 0),
    };
  },

  cacheVerify(cache) {
    let valid = 0;
    let quarantined = 0;
    const failures: string[] = [];
    for (const item of enumerateObjects(cache)) {
      try {
        const payload = readCasObject(cache, item.key, item.kind);
        if (payload === null) {
          throw new Error("object disappeared during verification");
        }
        if (item.kind === "state") {
          decodeBookState(runtime, payload);
        }
        valid += 1;
      } catch (error) {
        failures.push(`${item.key}: ${message(error)}`);
        quarantine(cache, item.key, error);
        quarantined += 1;
      }
    }
    return { root: cache, valid, quarantined, failures };
  },

  cacheGc(cache, live) {
    // Until durable build manifests are introduced, absence from `live` is not
    // proof of unreachability. GC therefore removes only abandoned temp files;
    // it never guesses that a valid immutable object is dead.
    const liveSet = new Set(live);
    let removedTemporary = 0;
    for (const file of walkFiles(cache)) {
      if (path.basename(file).includes(".tmp-")) {
        fs.rmSync(file, { force: true });
        removedTemporary += 1;
      }
    }
    return {
      root: cache,
      liveKeys: liveSet.size,
      removedTemporary,
      removedObjects: 0,
      conservative: true,
    };
  },
};

if (process.env.POC_DEBUG === "1" && globalThis.POC_HOST !== undefined) {
  const host = globalThis.POC_HOST;
  globalThis.POC_HOST = new Proxy(host, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") {
        return value;
      }
      return (...arguments_: unknown[]) => {
        process.stderr.write(`[poc-host] ${String(property)}\n`);
        return (value as (...items: unknown[]) => unknown)(...arguments_);
      };
    },
  }) as HostApi;
}

function readState(cache: string, key: string): BookStateLike | null {
  assertDigest(key);
  try {
    const payload = readCasObject(cache, key, "state");
    return payload === null ? null : decodeBookState(runtime, payload);
  } catch (error) {
    quarantine(cache, key, error);
    return null;
  }
}

function stageState(
  stage: StateStage,
  cache: string,
  key: string,
  state: BookStateLike,
): void {
  assertOpenStage(stage);
  assertDigest(key);
  if (stage.entries.some((entry) => entry.key === key)) {
    throw new Error(`checkpoint key staged twice: ${key}`);
  }
  const payload = path.join(stage.directory, `${stage.entries.length}.bin`);
  fs.writeFileSync(payload, encodeBookState(runtime, state), { mode: 0o600 });
  stage.entries.push({ cache, key, payload });
}

function runBookRead(
  file: string,
  namespace: string,
  seed?: BookStateLike,
): BookStateLike & { readonly n0: number } {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "poc-check-"));
  const seedPath = seed === undefined ? "-" : path.join(temporary, "seed.bin");
  const outputPath = path.join(temporary, "checked.bin");
  const n0Path = path.join(temporary, "n0.txt");
  try {
    if (seed !== undefined) {
      fs.writeFileSync(seedPath, encodeBookState(runtime, seed));
    }
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        compilerWorker,
        bend2Source,
        file,
        namespace,
        seedPath,
        outputPath,
        n0Path,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (child.exitCode !== 0) {
      const stderr = child.stderr.toString().trim();
      const stdout = child.stdout.toString().trim();
      throw new Error(stderr.length > 0 ? stderr : stdout || "Bend checker failed");
    }
    const checked = decodeBookState(runtime, fs.readFileSync(outputPath));
    const n0 = Number(fs.readFileSync(n0Path, "utf8").trim());
    if (!Number.isSafeInteger(n0) || n0 < 0) {
      throw new Error("compiler worker returned an invalid n0 marker");
    }
    return { ...checked, n0 };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function assertOpenStage(stage: StateStage): void {
  if (stage.closed || !fs.existsSync(stage.directory)) {
    throw new Error("checkpoint stage is already closed");
  }
}

function closeStage(stage: StateStage): void {
  fs.rmSync(stage.directory, { recursive: true, force: true });
  stage.closed = true;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`unsafe cache path segment: ${value}`);
  }
  return value;
}

function assertDigest(key: string): void {
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new Error(`invalid content-addressed key: ${key}`);
  }
}

function objectDirectory(cache: string, key: string): string {
  assertDigest(key);
  return path.join(cache, "objects", key.slice(0, 2), key);
}

function payloadName(kind: CasMetadata["kind"]): string {
  return kind === "state" ? "state.bin" : "artifact.bin";
}

function readCasObject(
  cache: string,
  key: string,
  expectedKind: CasMetadata["kind"],
): Buffer | null {
  const directory = objectDirectory(cache, key);
  const metadataPath = path.join(directory, "meta.json");
  if (!fs.existsSync(metadataPath)) {
    return null;
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as CasMetadata;
  if (
    metadata.schema !== 1 ||
    metadata.kind !== expectedKind ||
    metadata.key !== key ||
    !Number.isSafeInteger(metadata.bytes) ||
    metadata.bytes < 0 ||
    !/^[0-9a-f]{64}$/.test(metadata.payloadSha256)
  ) {
    throw new Error("invalid CAS metadata");
  }
  const payload = fs.readFileSync(path.join(directory, payloadName(expectedKind)));
  if (payload.byteLength !== metadata.bytes || sha256(payload) !== metadata.payloadSha256) {
    throw new Error("CAS payload digest mismatch");
  }
  return payload;
}

function putCasObject(
  cache: string,
  key: string,
  kind: CasMetadata["kind"],
  payload: Uint8Array,
): void {
  const directory = objectDirectory(cache, key);
  if (fs.existsSync(path.join(directory, "meta.json"))) {
    const existing = readCasObject(cache, key, kind);
    if (existing === null || !existing.equals(payload)) {
      throw new Error(`immutable CAS collision at ${key}`);
    }
    return;
  }

  const parent = path.dirname(directory);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${directory}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  fs.mkdirSync(temporary, { mode: 0o700 });
  try {
    const body = Buffer.from(payload);
    fs.writeFileSync(path.join(temporary, payloadName(kind)), body, { mode: 0o600 });
    const metadata: CasMetadata = {
      schema: 1,
      kind,
      key,
      payloadSha256: sha256(body),
      bytes: body.byteLength,
    };
    fs.writeFileSync(
      path.join(temporary, "meta.json"),
      `${JSON.stringify(metadata)}\n`,
      { mode: 0o600 },
    );
    try {
      fs.renameSync(temporary, directory);
    } catch (error) {
      if (!fs.existsSync(directory)) {
        throw error;
      }
      fs.rmSync(temporary, { recursive: true, force: true });
      const existing = readCasObject(cache, key, kind);
      if (existing === null || !existing.equals(body)) {
        throw new Error(`concurrent immutable CAS collision at ${key}`);
      }
    }
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function atomicWrite(output: string, payload: Uint8Array): void {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, payload, { mode: 0o600 });
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function quarantine(cache: string, key: string, reason: unknown): void {
  const source = objectDirectory(cache, key);
  if (!fs.existsSync(source)) {
    return;
  }
  const destination = path.join(
    cache,
    "quarantine",
    `${key}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(source, destination);
    fs.writeFileSync(path.join(destination, "reason.txt"), `${message(reason)}\n`, {
      mode: 0o600,
    });
  } catch {
    // A racing verifier may already have moved the object. A miss is safe.
  }
}

function enumerateObjects(cache: string): Array<CasMetadata> {
  const root = path.join(cache, "objects");
  if (!fs.existsSync(root)) {
    return [];
  }
  const result: CasMetadata[] = [];
  for (const file of walkFiles(root)) {
    if (path.basename(file) !== "meta.json") {
      continue;
    }
    try {
      result.push(JSON.parse(fs.readFileSync(file, "utf8")) as CasMetadata);
    } catch {
      // verify handles malformed objects; status remains available.
    }
  }
  return result;
}

function immutableIdentityOrTree(root: string): readonly NamedBytes[] {
  const resolved = fs.realpathSync(root);
  const match = resolved.match(/^(\/nix\/store\/[^/]+)/);
  if (match?.[1] !== undefined) {
    // Nix store paths are immutable content-addressed provenance. Bend still
    // performs the semantic BLAKE3/Merkle hashing; the host supplies only the
    // small immutable identity bytes instead of megabytes of source per run.
    return [{
      path: "nix-store-identity",
      bytes: Buffer.from(match[1], "utf8").toString("base64"),
    }];
  }
  return readTree(resolved);
}

function readTree(root: string): readonly NamedBytes[] {
  return walkFiles(root)
    .map((file) => ({
      path: path.relative(root, file).split(path.sep).join("/"),
      bytes: fs.readFileSync(file).toString("base64"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile()) {
        output.push(file);
      }
    }
  };
  visit(root);
  output.sort();
  return output;
}

function sha256(bytes: Uint8Array): string {
  // This checksum protects CAS storage bytes. Content-address keys themselves
  // are exclusively computed by Bend via bend-hashes/BLAKE3.
  return createHash("sha256").update(bytes).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): never {
  throw new Error(message);
}
