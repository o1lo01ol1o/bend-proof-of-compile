import * as fs from "node:fs";

import { decodeBookState, encodeBookState } from "./codec.ts";
import { loadCompiler } from "./compiler.ts";

const [bend2Source, file, namespace, seedPath, outputPath, n0Path] = process.argv.slice(2);
if (
  bend2Source === undefined ||
  file === undefined ||
  namespace === undefined ||
  seedPath === undefined ||
  outputPath === undefined ||
  n0Path === undefined
) {
  throw new Error(
    "compiler-worker requires source, file, namespace, seed, output and n0 paths",
  );
}

const runtime = await loadCompiler(bend2Source);
const seed = seedPath === "-"
  ? undefined
  : decodeBookState(runtime, fs.readFileSync(seedPath));
const checked = await runtime.bookRead(file, seed, namespace);
fs.writeFileSync(outputPath, encodeBookState(runtime, checked));
fs.writeFileSync(n0Path, `${checked.n0}\n`);
