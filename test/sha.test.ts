// The vendored SHA-224/256 (with nix/patches/bend-hashes-sha2_32-streaming.patch)
// against Node's: every key this application derives goes through it.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { loadCompiler } from "../src/compiler.ts";

const source = process.env.POC_BEND2_SOURCE;
if (source === undefined) {
  throw new Error("POC_BEND2_SOURCE is required");
}
const runtime = await loadCompiler(source);
const { book } = await runtime.bookRead(path.join(import.meta.dir, "fixtures", "sha", "Sha.bend"));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "poc-sha-")), "sha.js");
fs.writeFileSync(out, runtime.compileLibrary(book, ["Sha.s256", "Sha.s224", "Sha.b256", "Sha.b224"]));
const lib = (await import(pathToFileURL(out).href)).default as Record<string, (value: unknown) => string>;
const call = (name: string, value: unknown): string => {
  const f = lib[name];
  if (f === undefined) {
    throw new Error(`missing ${name}`);
  }
  return f(value);
};

const digest = (algorithm: string, bytes: Buffer): string =>
  createHash(algorithm).update(bytes).digest("hex");
const list = (bytes: number[]): unknown =>
  bytes.reduceRight<unknown>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });

test("NIST vectors", () => {
  expect(call("Sha.s256", "abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(call("Sha.s256", "")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(call("Sha.s224", "abc")).toBe("23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7");
});

test("text of every padding length and non-ASCII text", () => {
  const texts = ["héllo ✓ 𝔘nicode", ...Array.from({ length: 200 }, (_, n) => "ab".repeat(n).slice(0, n))];
  for (const text of texts) {
    const bytes = Buffer.from(text, "utf8");
    expect(call("Sha.s256", text)).toBe(digest("sha256", bytes));
    expect(call("Sha.s224", text)).toBe(digest("sha224", bytes));
  }
});

test("byte lists of every padding length", () => {
  for (let length = 0; length < 200; length += 1) {
    const bytes = Array.from({ length }, (_, index) => (index * 131 + length) % 256);
    expect(call("Sha.b256", list(bytes))).toBe(digest("sha256", Buffer.from(bytes)));
    expect(call("Sha.b224", list(bytes))).toBe(digest("sha224", Buffer.from(bytes)));
  }
});

test("a long message hashes without growing the stack", () => {
  const text = "q".repeat(2_000_000);
  expect(call("Sha.s256", text)).toBe(digest("sha256", Buffer.from(text, "utf8")));
});
