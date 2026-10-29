#!/usr/bin/env bun

import * as path from "node:path";
import { pathToFileURL } from "node:url";

import "./host-preload.ts";

// The generated executable owns arguments, effects, scheduling and exit.
// This entrypoint installs capabilities only; it does not interpret Bend IO.
const applicationPath = process.env.POC_APP_JS ?? path.resolve("dist/app.js");
await import(pathToFileURL(applicationPath).href);
