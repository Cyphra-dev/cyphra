import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Module hooks (run on Node's loader thread) so the CLI imports a user's TypeScript modules
 * (`graphql.config.ts`, `--typedefs typeDefs.ts`, …) and their relative imports without extra
 * flags:
 * - `resolve`: from a `.ts` / `.mts` module, a relative `./x.js` / `./x.mjs` that does not exist
 *   resolves to `./x.ts` / `./x.mts` (the NodeNext style TypeScript itself resolves). Node's own
 *   type stripping does not map them.
 * - `load`: a `.ts` / `.mts` file outside `node_modules` is transpiled with `typescript` (so
 *   enums, parameter properties, … work, and on a Node without type stripping too).
 */
const HOOKS = `
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
let tsUrl;
let ts;
const TS = /\\.m?ts$/;
export function initialize(data) { tsUrl = data.typescript; }
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const parent = context.parentURL;
    const m = /^(\\.{1,2}\\/.*)\\.(m?)js$/.exec(specifier);
    if (err?.code !== "ERR_MODULE_NOT_FOUND" || !m || !parent || !TS.test(new URL(parent).pathname)) throw err;
    try {
      return await next(m[1] + "." + m[2] + "ts", context);
    } catch {
      throw err;
    }
  }
}
export async function load(url, context, next) {
  if (!url.startsWith("file:")) return next(url, context);
  const file = fileURLToPath(url);
  if (!TS.test(file) || /[\\\\/]node_modules[\\\\/]/.test(file)) return next(url, context);
  ts ??= (await import(tsUrl)).default;
  const source = ts.transpileModule(await readFile(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
    fileName: file,
  }).outputText;
  return { format: "module", source, shortCircuit: true };
}
`;

let registered = false;

/** Registers the {@link HOOKS} once per process (before the CLI imports a user's module). */
export function registerTsHooks(): void {
  if (registered) return;
  registered = true;
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
  register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, {
    data: { typescript },
  });
}
