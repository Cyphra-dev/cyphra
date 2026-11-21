/**
 * Edge compatibility of the meta-package: under the `workerd` / `edge-light` conditions, what a
 * generated client imports from `cyphra` bundles for a neutral platform, with no Node.js built-in
 * and no `neo4j-driver` (needs the workspace packages built, as in CI).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = ["cyphra", "runtime", "schema", "query"].every((p) =>
  existsSync(path.join(pkgRoot, "..", p, "dist/index.js")),
);

describe.skipIf(!built)("cyphra edge build", () => {
  it.each(["workerd", "edge-light"])("bundles under the %s condition", async (condition) => {
    const result = await build({
      stdin: {
        contents: `export { createOrm, CyphraClient, cypher, parseSchema, resolveSchema } from "cyphra";`,
        resolveDir: pkgRoot,
        loader: "ts",
      },
      bundle: true,
      write: false,
      platform: "neutral",
      format: "esm",
      mainFields: ["module", "main"],
      conditions: [condition],
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(
      inputs.some((i) => /(^|\/)cyphra\/dist\/edge\.js$/.test(i) || i === "dist/edge.js"),
    ).toBe(true);
    expect(inputs.some((i) => /runtime\/dist\/edge\.js$/.test(i))).toBe(true);
    expect(inputs.some((i) => i.includes("neo4j-driver") || i.includes("migrator"))).toBe(false);
    for (const output of Object.values(result.metafile.outputs)) {
      expect(output.imports).toEqual([]);
    }
  });
});
