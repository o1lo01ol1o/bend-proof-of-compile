import * as fs from "node:fs";
import * as path from "node:path";

import { loadCompiler } from "./compiler.ts";

const [bend2Source, source, output] = process.argv.slice(2);
if (bend2Source === undefined || source === undefined || output === undefined) {
  throw new Error("usage: build-bend-lib BEND2_SOURCE APP.bend OUTPUT.js");
}

const runtime = await loadCompiler(bend2Source);
const checked = await runtime.bookRead(path.resolve(source));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, runtime.compileLibrary(checked.book, ["Cli.program"]));
