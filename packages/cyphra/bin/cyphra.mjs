#!/usr/bin/env node
/**
 * Shim so the `cyphra` meta-package exposes the same CLI as `@cyphra/cli`
 * (pnpm does not hoist transitive `bin` entries to the dependent’s `.bin`).
 * We spawn Node on the CLI bundle so its shebang/banner is not parsed as ESM.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const entry = require.resolve("@cyphra/cli/dist/index.js");
const r = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
