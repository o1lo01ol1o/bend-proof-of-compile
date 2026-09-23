import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { decodePack, encodePack, pathReal } from "./codec.ts";
import {
  reloadTrust,
  statementText,
  verifySignature,
  type Signature,
  type Statement,
} from "./trust.ts";
import {
  loadCompiler,
  type BookStateLike,
  type CheckGroup,
  type LateFill,
  type LoadOrder,
  type LoadStep,
  type Target,
  type Verdict,
} from "./compiler.ts";

interface NamedBytes {
  readonly path: string;
  readonly bytes: string;
}

// A state object is one pack; `foreigns` lists the foreign files named by
// the records of its whole chain, so an artifact key can be derived without
// restoring the state. Every object's metadata is signed (trust option (b)):
// the signature covers its statement, which includes the payload's digest.
type CasMetadata = Statement & { readonly schema: 3; readonly signature: Signature };

type CasKind = Statement["kind"];

interface StateRecord {
  readonly parent: string | null;
  readonly foreigns: readonly string[];
}

interface ResumeCandidate {
  readonly key: string;
  readonly groups: readonly CheckGroup[];
}

// A restored or checked state, with what its packs need (the key it is
// stored under and the foreign files its chain names), `n0`, where its last
// file's claims begin, and whether every record carries its elaboration:
// only a state checked from nothing in this process does, and only such a
// state is emitted directly.
interface HeldState extends BookStateLike {
  readonly key: string;
  readonly foreigns: readonly string[];
  readonly n0: number;
  readonly elaborations: "complete" | "restored";
}

interface StateStage {
  readonly directory: string;
  readonly entries: Array<{
    readonly cache: string;
    readonly key: string;
    readonly payload: string;
    readonly record: StateRecord;
  }>;
  closed: boolean;
}

interface HostApi {
  cacheRoot(namespace: string, version: string): string;
  compilerInputs(): { compiler: readonly NamedBytes[]; hashes: readonly NamedBytes[] };
  loadSteps(entry: string): Promise<LoadOrder>;
  loadFills(root: string, steps: readonly LoadStep[]): Promise<LateFill[]>;
  stateGet(cache: string, key: string): { readonly state: HeldState; readonly verdict: Verdict } | null;
  stateGetLongest(
    cache: string,
    candidates: readonly ResumeCandidate[],
  ): { readonly state: HeldState; readonly groups: readonly CheckGroup[] } | null;
  stateForeigns(cache: string, key: string): readonly NamedBytes[] | null;
  stageStart(): StateStage;
  stageCommit(stage: StateStage): void;
  stageAbort(stage: StateStage): void;
  bookCheck(
    cache: string,
    root: string,
    groups: readonly CheckGroup[],
    seed: HeldState | undefined,
    stage: StateStage,
  ): Promise<{ readonly state: HeldState; readonly stage: StateStage; readonly verdict: Verdict }>;
  outputPath(output: string): { readonly real: string; readonly directory: boolean };
  artifactRestore(cache: string, key: string, output: string): readonly string[] | null;
  outputRemove(output: string): void;
  artifactBuild(
    cache: string,
    key: string,
    output: string,
    target: Target,
    state: HeldState,
    reliant: readonly string[],
  ): void;
  rootsPut(cache: string, root: string, live: readonly string[]): void;
  rootsLive(cache: string): readonly string[];
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
let memoizedInputs:
  | { compiler: readonly NamedBytes[]; hashes: readonly NamedBytes[] }
  | undefined;

globalThis.POC_HOST = {
  cacheRoot(namespace, version) {
    const root = path.join(os.tmpdir(), safeSegment(namespace), safeSegment(version));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    // Integrity does not rest on who can write here: every object is signed,
    // and only objects signed by a trusted key are read (trust option (b)).
    return root;
  },

  compilerInputs() {
    memoizedInputs ??= {
      compiler: immutableIdentityOrTree(bend2Source),
      hashes: immutableIdentityOrTree(hashesSource),
    };
    return memoizedInputs;
  },

  loadSteps(entry) {
    return runtime.loadSteps(entry);
  },

  loadFills(root, steps) {
    return runtime.loadFills(root, steps);
  },

  stateGet(cache, key) {
    const state = readState(cache, key);
    return state === null ? null : { state, verdict: runtime.verdict(state, state.n0) };
  },

  stateGetLongest(cache, candidates) {
    for (const [index, candidate] of candidates.entries()) {
      const state = readState(cache, candidate.key);
      if (state !== null) {
        debug(
          `resumePrefix rank=${index} remainingGroups=${candidate.groups.length} ` +
            `remainingSteps=${stepCount(candidate.groups)}`,
        );
        return { state, groups: candidate.groups };
      }
    }
    debug("resumePrefix miss");
    return null;
  },

  stateForeigns(cache, key) {
    const record = readStateRecord(cache, key);
    return record === null
      ? null
      : record.foreigns.map((file) => ({
          path: file,
          bytes: fs.readFileSync(file).toString("base64"),
        }));
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
      // A pack is published after the packs it extends.
      putCasObjects(stage.entries.map((entry) => ({
        cache: entry.cache,
        key: entry.key,
        payload: fs.readFileSync(entry.payload),
        entry: { kind: "state", record: entry.record } as const,
      })));
    } finally {
      closeStage(stage);
    }
  },

  stageAbort(stage) {
    if (!stage.closed) {
      closeStage(stage);
    }
  },

  async bookCheck(cache, root, groups, seed, stage) {
    assertOpenStage(stage);
    debug(
      `check groups=${groups.length} steps=${stepCount(groups)} seeded=${seed !== undefined}`,
    );
    try {
      const keys = new Map<BookStateLike, HeldState>();
      if (seed !== undefined) {
        keys.set(seed, seed);
      }
      const elaborations = seed === undefined ? "complete" : "restored";
      const checked = await runtime.check(root, groups, seed, (key, parent, child, last) => {
        const held = keys.get(parent);
        const foreigns = mergeForeigns(held?.foreigns ?? [], ownForeigns(child));
        stageState(stage, cache, key, encodePack(runtime, held?.key ?? null, parent, child, last), {
          parent: held?.key ?? null,
          foreigns,
        });
        keys.set(child, { ...child, key, foreigns, n0: last, elaborations });
      });
      const state = keys.get(checked.state);
      if (state === undefined || state === seed) {
        throw new Error("a check plan must have at least one group");
      }
      return { state, stage, verdict: runtime.verdict(state, state.n0) };
    } catch (error) {
      if (!stage.closed) {
        closeStage(stage);
      }
      throw error;
    }
  },

  outputPath(output) {
    const real = pathReal(output);
    return { real, directory: fs.existsSync(real) && fs.statSync(real).isDirectory() };
  },

  artifactRestore(cache, key, output) {
    assertDigest(key);
    try {
      const artifact = readCasObject(cache, key, "artifact");
      if (artifact === null) {
        return null;
      }
      atomicWrite(path.resolve(output), artifact.payload);
      return artifact.reliant;
    } catch (error) {
      quarantine(cache, key, error);
      return null;
    }
  },

  outputRemove(output) {
    fs.rmSync(path.resolve(output), { force: true });
  },

  artifactBuild(cache, key, output, target, state, reliant) {
    assertDigest(key);
    const source = state.elaborations === "complete"
      ? runtime.emit(state.book, target)
      : runtime.emitRestored(state, target);
    const payload = Buffer.from(source, "utf8");
    putCasObjects([{ cache, key, payload, entry: { kind: "artifact", reliant } }]);
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

  // Every object: valid (signed by a trusted key, intact, decodable),
  // untrusted (a valid signature by a key that is not trusted; left in place,
  // never read), or quarantined.
  cacheVerify(cache) {
    let valid = 0;
    let untrusted = 0;
    let quarantined = 0;
    const failures: string[] = [];
    for (const item of enumerateObjects(cache)) {
      try {
        const object = readCasObject(cache, item.key, item.kind);
        if (object === null) {
          untrusted += 1;
          continue;
        }
        if (item.kind === "state") {
          decodePack(runtime, object.payload).force();
        }
        valid += 1;
      } catch (error) {
        failures.push(`${item.key}: ${message(error)}`);
        quarantine(cache, item.key, error);
        quarantined += 1;
      }
    }
    return { root: cache, valid, untrusted, quarantined, failures };
  },

  rootsPut(cache, root, live) {
    assertDigest(root);
    live.forEach(assertDigest);
    atomicWrite(path.join(cache, "roots", `${root}.json`), Buffer.from(
      `${JSON.stringify({ schema: 1, live: [...live] })}\n`,
      "utf8",
    ));
  },

  rootsLive(cache) {
    const directory = path.join(cache, "roots");
    const live = new Set<string>();
    for (const file of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
      if (!/^[0-9a-f]{64}\.json$/.test(file)) {
        continue;
      }
      const record = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) as unknown;
      const keys = (record as { schema?: unknown; live?: unknown } | null);
      if (keys?.schema !== 1 || !Array.isArray(keys.live)) {
        throw new Error(`invalid GC root ${file}`);
      }
      for (const key of keys.live) {
        if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) {
          throw new Error(`invalid GC root ${file}`);
        }
        live.add(key);
      }
    }
    return [...live];
  },

  cacheGc(cache, live) {
    // Reachability: a live state keeps its whole chain of packs; a live
    // artifact keeps itself. Every other object, and every abandoned temporary
    // file, is removed. A build racing GC can lose a parent it was about to
    // extend; its chain then fails to restore, which is a miss, never a
    // wrong state.
    const reachable = new Set<string>();
    for (const key of live) {
      assertDigest(key);
      for (let cursor: string | null = key; cursor !== null && !reachable.has(cursor);) {
        reachable.add(cursor);
        const kind = objectKind(cache, cursor);
        cursor = kind === "state" ? readStateRecord(cache, cursor)?.parent ?? null : null;
      }
    }
    let removedTemporary = 0;
    for (const file of walkFiles(cache)) {
      if (path.basename(file).includes(".tmp-")) {
        fs.rmSync(file, { force: true });
        removedTemporary += 1;
      }
    }
    let removedObjects = 0;
    let removedBytes = 0;
    for (const item of enumerateObjects(cache)) {
      if (!reachable.has(item.key)) {
        fs.rmSync(objectDirectory(cache, item.key), { recursive: true, force: true });
        removedObjects += 1;
        removedBytes += item.bytes;
      }
    }
    return {
      root: cache,
      liveKeys: live.length,
      reachable: reachable.size,
      removedObjects,
      removedBytes,
      removedTemporary,
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

function debug(line: string): void {
  if (process.env.POC_DEBUG === "1") {
    process.stderr.write(`[poc-host] ${line}\n`);
  }
}

function stepCount(groups: readonly CheckGroup[]): number {
  return groups.reduce((total, group) => total + group.steps.length, 0);
}

// Restores the chain of packs ending at `key` into one flat book. A missing
// or corrupt link makes the state absent; a corrupt one is quarantined.
function readState(cache: string, key: string): HeldState | null {
  assertDigest(key);
  const chain: Array<{ key: string; payload: Buffer; record: StateRecord }> = [];
  let cursor: string | null = key;
  try {
    while (cursor !== null) {
      const object: { readonly payload: Buffer; readonly record: StateRecord } | null = readCasObject(cache, cursor, "state");
      if (object === null) {
        return null;
      }
      chain.push({ key: cursor, payload: object.payload, record: object.record });
      cursor = object.record.parent;
      if (chain.length > 100_000) {
        throw new Error("state chain does not end");
      }
    }
  } catch (error) {
    quarantine(cache, cursor ?? key, error);
    return null;
  }
  const state: BookStateLike = { book: runtime.Bend.book_nil(), seen: new Map() };
  let headLast = 0;
  for (const link of chain.reverse()) {
    try {
      const pack = decodePack(runtime, link.payload);
      if (pack.parent !== link.record.parent) {
        throw new Error("pack parent disagrees with its metadata");
      }
      pack.apply(state);
      headLast = pack.last;
    } catch (error) {
      quarantine(cache, link.key, error);
      return null;
    }
  }
  const head = chain[chain.length - 1];
  return {
    ...state,
    key,
    foreigns: head?.record.foreigns ?? [],
    n0: headLast,
    elaborations: "restored",
  };
}

function readStateRecord(cache: string, key: string): StateRecord | null {
  assertDigest(key);
  try {
    const metadata = readCasMetadata(cache, key, "state");
    return metadata?.kind === "state"
      ? { parent: metadata.parent, foreigns: metadata.foreigns }
      : null;
  } catch (error) {
    quarantine(cache, key, error);
    return null;
  }
}

// The foreign files a pack's own records name, as absolute paths.
function ownForeigns(state: BookStateLike): string[] {
  const files: string[] = [];
  for (const name of Object.keys(state.book.tlds)) {
    const tld = state.book.tlds[name];
    if (tld?.$ === "Def" && tld.i !== undefined) {
      files.push(...tld.i.map(pathReal));
    }
  }
  return files;
}

function mergeForeigns(inherited: readonly string[], own: readonly string[]): string[] {
  return [...new Set([...inherited, ...own])].sort();
}

function stageState(
  stage: StateStage,
  cache: string,
  key: string,
  payload: Buffer,
  record: StateRecord,
): void {
  assertOpenStage(stage);
  assertDigest(key);
  if (stage.entries.some((entry) => entry.key === key)) {
    throw new Error(`checkpoint key staged twice: ${key}`);
  }
  const file = path.join(stage.directory, `${stage.entries.length}.bin`);
  fs.writeFileSync(file, payload, { mode: 0o600 });
  stage.entries.push({ cache, key, payload: file, record });
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

function payloadName(kind: CasKind): string {
  return kind === "state" ? "state.bin" : "artifact.bin";
}

type CasEntry =
  | { readonly kind: "state"; readonly record: StateRecord }
  | { readonly kind: "artifact"; readonly reliant: readonly string[] };

function parseCasMetadata(raw: unknown, key: string, expectedKind: CasKind): CasMetadata {
  const invalid = (): never => {
    throw new Error("invalid CAS metadata");
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalid();
  }
  const value = raw as Record<string, unknown>;
  if (
    value.schema !== 3 ||
    value.kind !== expectedKind ||
    value.key !== key ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    typeof value.payloadSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.payloadSha256)
  ) {
    return invalid();
  }
  const signature = value.signature as { key?: unknown; sig?: unknown } | null | undefined;
  if (typeof signature?.key !== "string" || typeof signature.sig !== "string") {
    return invalid();
  }
  const common = {
    schema: 3,
    key,
    payloadSha256: value.payloadSha256,
    bytes: value.bytes,
    signature: { key: signature.key, sig: signature.sig },
  } as const;
  if (expectedKind === "artifact") {
    const reliant = value.reliant;
    if (!Array.isArray(reliant) || !reliant.every((name): name is string => typeof name === "string")) {
      return invalid();
    }
    return { ...common, kind: "artifact", reliant };
  }
  const parent = value.parent;
  const foreigns = value.foreigns;
  if (
    !(parent === null || (typeof parent === "string" && /^[0-9a-f]{64}$/.test(parent))) ||
    !Array.isArray(foreigns) ||
    !foreigns.every((file): file is string => typeof file === "string" && path.isAbsolute(file))
  ) {
    return invalid();
  }
  return { ...common, kind: "state", parent, foreigns };
}

// The kind an object's metadata declares, or null when there is no object
// (or no readable kind: a read of it by kind quarantines it).
function objectKind(cache: string, key: string): CasKind | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(objectDirectory(cache, key), "meta.json"), "utf8"),
    ) as { kind?: unknown } | null;
    return raw?.kind === "state" || raw?.kind === "artifact" ? raw.kind : null;
  } catch {
    return null;
  }
}

// An object's verified metadata: null when there is none or its signer is not
// trusted (a miss, left in place); an error when it is malformed or its
// signature does not verify (the caller quarantines it).
function readCasMetadata(cache: string, key: string, kind: CasKind): CasMetadata | null {
  const metadataPath = path.join(objectDirectory(cache, key), "meta.json");
  if (!fs.existsSync(metadataPath)) {
    return null;
  }
  const metadata = parseCasMetadata(JSON.parse(fs.readFileSync(metadataPath, "utf8")), key, kind);
  const verdict = verifySignature(metadata, metadata.signature);
  if (verdict === "invalid") {
    throw new Error("CAS signature does not verify");
  }
  return verdict === "trusted" ? metadata : null;
}

function readCasObject(
  cache: string,
  key: string,
  kind: "state",
): { readonly payload: Buffer; readonly record: StateRecord } | null;
function readCasObject(
  cache: string,
  key: string,
  kind: CasKind,
): { readonly payload: Buffer } | null;
function readCasObject(
  cache: string,
  key: string,
  kind: "artifact",
): { readonly payload: Buffer; readonly reliant: readonly string[] } | null;
function readCasObject(
  cache: string,
  key: string,
  kind: CasKind,
): { readonly payload: Buffer; readonly record?: StateRecord; readonly reliant?: readonly string[] } | null {
  const metadata = readCasMetadata(cache, key, kind);
  if (metadata === null) {
    return null;
  }
  const payload = fs.readFileSync(path.join(objectDirectory(cache, key), payloadName(kind)));
  if (payload.byteLength !== metadata.bytes || sha256(payload) !== metadata.payloadSha256) {
    throw new Error("CAS payload digest mismatch");
  }
  return metadata.kind === "state"
    ? { payload, record: { parent: metadata.parent, foreigns: metadata.foreigns } }
    : { payload, reliant: metadata.reliant };
}

interface Publication {
  readonly cache: string;
  readonly key: string;
  readonly payload: Uint8Array;
  readonly entry: CasEntry;
}

// The signer (src/signer.ts) signs every statement in one call; it is the
// only process that reads the signing key.
const signerProgram = fileURLToPath(new URL("./signer.ts", import.meta.url));

function signStatements(statements: readonly Statement[]): Signature[] {
  if (statements.length === 0) {
    return [];
  }
  const child = Bun.spawnSync({
    cmd: [process.execPath, signerProgram, "sign"],
    stdin: Buffer.from(JSON.stringify({ statements: statements.map(statementText) }), "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw new Error(`the signer failed: ${child.stderr.toString().trim()}`);
  }
  const signed = JSON.parse(child.stdout.toString()) as { key?: unknown; signatures?: unknown };
  const signatures = signed.signatures;
  if (
    typeof signed.key !== "string" ||
    !Array.isArray(signatures) ||
    signatures.length !== statements.length ||
    !signatures.every((sig): sig is string => typeof sig === "string")
  ) {
    throw new Error("the signer returned a malformed answer");
  }
  // A first signature may have created the key and trusted it.
  reloadTrust();
  const key = signed.key;
  return signatures.map((sig) => ({ key, sig }));
}

// Publishes objects in order (a pack after the packs it extends). An object
// already present under a key must hold the same payload; one whose signer is
// not trusted, or whose signature does not verify, is replaced.
function putCasObjects(publications: readonly Publication[]): void {
  const pending = publications.filter((publication) => {
    const directory = objectDirectory(publication.cache, publication.key);
    if (!fs.existsSync(path.join(directory, "meta.json"))) {
      return true;
    }
    let existing: { readonly payload: Buffer } | null;
    try {
      existing = readCasObject(publication.cache, publication.key, publication.entry.kind);
    } catch (error) {
      quarantine(publication.cache, publication.key, error);
      return true;
    }
    if (existing === null) {
      quarantine(publication.cache, publication.key, "signed by a key that is not trusted");
      return true;
    }
    if (!existing.payload.equals(publication.payload)) {
      throw new Error(`immutable CAS collision at ${publication.key}`);
    }
    return false;
  });
  const statements: Statement[] = pending.map(({ key, payload, entry }) => {
    const common = { key, payloadSha256: sha256(payload), bytes: payload.byteLength };
    return entry.kind === "state"
      ? { ...common, kind: "state", parent: entry.record.parent, foreigns: entry.record.foreigns }
      : { ...common, kind: "artifact", reliant: entry.reliant };
  });
  const signatures = signStatements(statements);
  pending.forEach((publication, index) => {
    const statement = statements[index] as Statement;
    const signature = signatures[index] as Signature;
    writeCasObject(publication, { ...statement, schema: 3, signature });
  });
}

function writeCasObject(publication: Publication, metadata: CasMetadata): void {
  const { cache, key, payload, entry } = publication;
  const directory = objectDirectory(cache, key);
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  const temporary = `${directory}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  fs.mkdirSync(temporary, { mode: 0o700 });
  try {
    const body = Buffer.from(payload);
    fs.writeFileSync(path.join(temporary, payloadName(entry.kind)), body, { mode: 0o600 });
    fs.writeFileSync(path.join(temporary, "meta.json"), `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    try {
      fs.renameSync(temporary, directory);
    } catch (error) {
      if (!fs.existsSync(directory)) {
        throw error;
      }
      fs.rmSync(temporary, { recursive: true, force: true });
      const existing = readCasObject(cache, key, entry.kind);
      if (existing === null || !existing.payload.equals(body)) {
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

// Every object in the store, trusted or not, by its declared kind and size
// (what status, GC and verify walk; reads verify).
function enumerateObjects(cache: string): Array<{ readonly key: string; readonly kind: CasKind; readonly bytes: number }> {
  const root = path.join(cache, "objects");
  if (!fs.existsSync(root)) {
    return [];
  }
  const result: Array<{ key: string; kind: CasKind; bytes: number }> = [];
  for (const file of walkFiles(root)) {
    if (path.basename(file) !== "meta.json") {
      continue;
    }
    const key = path.basename(path.dirname(file));
    const kind = objectKind(cache, key);
    if (kind === null || !/^[0-9a-f]{64}$/.test(key)) {
      continue;
    }
    const bytes = fs.readdirSync(path.dirname(file))
      .filter((name) => name !== "meta.json")
      .reduce((total, name) => total + fs.statSync(path.join(path.dirname(file), name)).size, 0);
    result.push({ key, kind, bytes });
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
