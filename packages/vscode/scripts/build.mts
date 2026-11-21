// Build the extension: generate the TextMate grammar from @cyphra/schema's type list, then bundle
// the extension (client) and the language server into dist/ (CommonJS, no runtime dependencies).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCALAR_TYPE_NAMES } from "@cyphra/schema";
import { build } from "esbuild";
import { buildGrammar } from "../src/grammar.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const production = process.argv.includes("--production");

mkdirSync(path.join(root, "syntaxes"), { recursive: true });
writeFileSync(
  path.join(root, "syntaxes/cyphra.tmLanguage.json"),
  `${JSON.stringify(buildGrammar(SCALAR_TYPE_NAMES), null, 2)}\n`,
);

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: !production,
  minify: production,
  logLevel: "warning",
} as const;

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, "src/extension.ts")],
    outfile: path.join(root, "dist/extension.js"),
    external: ["vscode"],
  }),
  build({
    ...common,
    entryPoints: [path.join(root, "src/server.ts")],
    outfile: path.join(root, "dist/server.js"),
  }),
]);
console.log("Built dist/extension.js, dist/server.js and syntaxes/cyphra.tmLanguage.json");
