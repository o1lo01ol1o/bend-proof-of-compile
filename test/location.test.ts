// A rejection's source position, from the span of Bend's error.
import { expect, test } from "bun:test";
import * as path from "node:path";

import { errorLocation, locationText, withoutPosition } from "../src/compiler.ts";

const str = "import Base\n\ndef f() -> Nat:\n  g(1n,\n    2n)\n";
const err = (beg: number, end: number, ns = "m"): unknown => ({ $: "Err", spn: { file: { str, ns }, beg, end } });
const sources = new Map([["m", path.join(process.cwd(), "src", "M.bend")]]);

test("a span on one line reads LINE:COL-ENDCOL, columns from 1", () => {
  const beg = str.indexOf("g(1n");
  const location = errorLocation(err(beg, beg + 1), sources);
  expect(location).toEqual({ path: path.join("src", "M.bend"), line: 4, column: 3, endLine: 4, endColumn: 3 });
  expect(locationText(location!)).toBe("src/M.bend:4:3");
  expect(locationText(errorLocation(err(beg, beg + 4), sources)!)).toBe("src/M.bend:4:3-6");
});

test("a span across lines names its last line", () => {
  const beg = str.indexOf("g(1n");
  const end = str.indexOf("2n)") + 3;
  expect(locationText(errorLocation(err(beg, end), sources)!)).toBe("src/M.bend:4:3-5:7");
});

test("no position without a span, a known file, or a Bend error", () => {
  expect(errorLocation(err(0, 1, "elsewhere"), sources)).toBeUndefined();
  expect(errorLocation({ $: "Err" }, sources)).toBeUndefined();
  expect(errorLocation(new Error("x"), sources)).toBeUndefined();
  expect(errorLocation(null, sources)).toBeUndefined();
});

test("cold equivalence drops only the position line", () => {
  const checker = "SOME PROOFS FAIL\nError:\n- message  : x\nLocation: f\n";
  expect(withoutPosition(checker + "At: src/M.bend:4:3-6\n")).toBe(checker);
  expect(withoutPosition(checker + "At: nowhere\n")).toBe(checker + "At: nowhere\n");
});
