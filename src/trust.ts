// Trust (SPEC-incremental-compilation.md §7, option (b)): every CAS object's
// metadata is signed by a signer (src/signer.ts, the only reader of the
// private key) and verified on read against the trusted public keys. A
// content key names the inputs a state claims; the signature says a trusted
// signer published it.
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function configDirectory(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "bend-proof-of-compile");
}

export function signingKeyPath(): string {
  return process.env.POC_SIGNING_KEY ?? path.join(configDirectory(), "signing-key.pem");
}

export function trustedKeysPath(): string {
  return process.env.POC_TRUSTED_KEYS ?? path.join(configDirectory(), "trusted-keys");
}

// A public key's name: "ed25519:" and its 32 raw bytes in base64url.
export function publicKeyId(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("a signing key must be Ed25519");
  }
  return `ed25519:${jwk.x}`;
}

export function parsePublicKeyId(id: string): KeyObject {
  const match = /^ed25519:([A-Za-z0-9_-]{43})$/.exec(id);
  if (match?.[1] === undefined) {
    throw new Error(`not an Ed25519 public key: ${id}`);
  }
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: match[1] }, format: "jwk" });
}

// What a signature covers: an object's whole metadata but the signature,
// in a fixed order, under a domain tag.
export type Statement =
  | {
      readonly kind: "state";
      readonly key: string;
      readonly payloadSha256: string;
      readonly bytes: number;
      readonly parent: string | null;
      readonly foreigns: readonly string[];
    }
  | {
      readonly kind: "artifact";
      readonly key: string;
      readonly payloadSha256: string;
      readonly bytes: number;
      readonly reliant: readonly string[];
    };

export function statementText(statement: Statement): string {
  const common = ["bend-proof-of-compile/cas/v3", statement.kind, statement.key, statement.payloadSha256, statement.bytes];
  return JSON.stringify(statement.kind === "state"
    ? [...common, statement.parent, statement.foreigns]
    : [...common, statement.reliant]);
}

export interface Signature {
  readonly key: string;
  readonly sig: string;
}

// A signature by a trusted key that verifies; a valid signature by a key that
// is not trusted; or one that does not verify (tampering).
export type Verdict = "trusted" | "untrusted" | "invalid";

let trusted: Map<string, KeyObject> | undefined;

function trustedKeys(): Map<string, KeyObject> {
  if (trusted === undefined) {
    trusted = new Map();
    const file = trustedKeysPath();
    const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
    for (const line of lines.map((item) => item.trim()).filter((item) => item !== "" && !item.startsWith("#"))) {
      trusted.set(line, parsePublicKeyId(line));
    }
  }
  return trusted;
}

// Forgets the loaded trusted keys (the signer may have just created the key
// and trusted it).
export function reloadTrust(): void {
  trusted = undefined;
}

export function verifySignature(statement: Statement, signature: Signature): Verdict {
  let key: KeyObject;
  try {
    key = trustedKeys().get(signature.key) ?? parsePublicKeyId(signature.key);
  } catch {
    return "invalid";
  }
  const valid = verify(null, Buffer.from(statementText(statement), "utf8"), key, Buffer.from(signature.sig, "base64"));
  return !valid ? "invalid" : trustedKeys().has(signature.key) ? "trusted" : "untrusted";
}
