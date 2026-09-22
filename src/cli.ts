#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import "./host-preload.ts";

interface BendOperation {
  readonly $: string;
  readonly run?: (...arguments_: unknown[]) => unknown;
  readonly args?: readonly unknown[];
  readonly kont?: (value: unknown) => BendOperation;
  readonly code?: number;
  readonly message?: string;
  readonly value?: unknown;
  readonly need?: () => { readonly time?: boolean; readonly read?: boolean };
}

type BendAction = (continuation: unknown) => BendOperation;
type BendExports = Readonly<Record<string, (...arguments_: unknown[]) => unknown>>;

declare global {
  var io_out: ((fd: number, data: Uint8Array) => void) | undefined;
  var io_bytes: ((text: string) => Uint8Array) | undefined;
  var io_tup: ((...values: unknown[]) => unknown) | undefined;
}

globalThis.io_out = (fd, data) => {
  fs.writeSync(fd, data);
};
globalThis.io_bytes = (text) => new TextEncoder().encode(text);
globalThis.io_tup = (...values) => {
  if (values.length === 0) {
    return { $: "Unit" };
  }
  return values
    .slice(0, -1)
    .reduceRight<unknown>(
      (snd, fst) => ({ $: "Tuple", fst, snd }),
      values[values.length - 1],
    );
};

const libraryPath = process.env.POC_APP_LIB ?? path.resolve("dist/app-lib.js");
const loaded = (await import(pathToFileURL(libraryPath).href)) as {
  readonly default?: BendExports;
};
const application = loaded.default ?? (loaded as unknown as BendExports);
const program = application["Cli.program"];
if (typeof program !== "function") {
  throw new Error(`compiled Bend library ${libraryPath} does not export Cli.program`);
}

const action = program(toBendList(process.argv.slice(2))) as BendAction;
runIo(action);

function runIo(action: BendAction): void {
  let operation = action((value: unknown): BendOperation => ({ $: "Emit", value }));
  for (;;) {
    if (operation.$ === "Emit") {
      return;
    }
    if (operation.$ === "Halt") {
      if (operation.message !== undefined) {
        process.stderr.write(`${operation.message}\n`);
      }
      process.exit(operation.code ?? 1);
    }
    if (
      operation.$ !== "$FFI" ||
      typeof operation.run !== "function" ||
      typeof operation.kont !== "function"
    ) {
      throw new Error(
        `compiled Bend program emitted an unknown IO operation: ${operation.$} (${Object.keys(operation).join(",")}; run=${typeof operation.run}; kont=${typeof operation.kont})`,
      );
    }
    const need = operation.need?.() ?? {};
    if (need.time || need.read) {
      throw new Error("proof-of-compile host received an unsupported asynchronous IO effect");
    }
    const value = operation.run(...(operation.args ?? []), operation.kont);
    if (value === undefined) {
      throw new Error("proof-of-compile host effect did not complete synchronously");
    }
    operation = operation.kont(value);
  }
}

function toBendList(values: readonly string[]): unknown {
  let result: unknown = { $: "Nil" };
  for (let index = values.length - 1; index >= 0; index -= 1) {
    result = { $: "Con", head: values[index], tail: result };
  }
  return result;
}
