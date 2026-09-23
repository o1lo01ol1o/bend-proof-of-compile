// The signer (SPEC-incremental-compilation.md, trust option (b)): the only
// process that reads the signing key. It never loads the checker, the compiled
// application or any program code; it signs the statements it is handed.
//
//   bun src/signer.ts sign        stdin {"statements": [..]}, stdout
//                                 {"key": "ed25519:..", "signatures": [..]}
//   bun src/signer.ts public      prints this signer's public key
//   bun src/signer.ts trust KEY   adds a public key to the trusted keys
//
// The key is created on first use, with this signer's public key trusted.
// Paths: POC_SIGNING_KEY (default $XDG_CONFIG_HOME/bend-proof-of-compile/
// signing-key.pem) and POC_TRUSTED_KEYS (default .../trusted-keys).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { publicKeyId, signingKeyPath, trustedKeysPath, parsePublicKeyId } from "./trust.ts";

function signingKey(): KeyObject {
  const file = signingKeyPath();
  if (!fs.existsSync(file)) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
      addTrusted(publicKeyId(publicKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  const mode = fs.statSync(file).mode;
  if ((mode & 0o077) !== 0) {
    throw new Error(`signing key ${file} must be readable by its owner only (mode 0600)`);
  }
  return createPrivateKey(fs.readFileSync(file));
}

function addTrusted(id: string): void {
  parsePublicKeyId(id);
  const file = trustedKeysPath();
  const known = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").map((line) => line.trim()) : [];
  if (!known.includes(id)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${id}\n`, { mode: 0o600 });
  }
}

const [command, argument] = process.argv.slice(2);
if (command === "sign") {
  const request = JSON.parse(fs.readFileSync(0, "utf8")) as { statements?: unknown };
  const statements = request.statements;
  if (!Array.isArray(statements) || !statements.every((item): item is string => typeof item === "string")) {
    throw new Error("the signer expects {\"statements\": [string, ...]}");
  }
  const key = signingKey();
  process.stdout.write(JSON.stringify({
    key: publicKeyId(createPublicKey(key)),
    signatures: statements.map((statement) => sign(null, Buffer.from(statement, "utf8"), key).toString("base64")),
  }));
} else if (command === "public") {
  process.stdout.write(`${publicKeyId(createPublicKey(signingKey()))}\n`);
} else if (command === "trust" && argument !== undefined) {
  addTrusted(argument);
} else {
  process.stderr.write("usage: signer.ts sign | public | trust ed25519:KEY\n");
  process.exit(2);
}
