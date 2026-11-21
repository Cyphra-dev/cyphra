/**
 * Edge compatibility: the edge build bundles for a neutral platform (no Node.js built-ins, no
 * `neo4j-driver`), as Vercel Edge and Cloudflare Workers require, and the bundle runs the ORM over
 * the HTTP transport with only `fetch`.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Metafile, type Plugin } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import tsupConfig from "../tsup.config.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const monorepo = path.resolve(pkgRoot, "../..");
const outDir = mkdtempSync(path.join(tmpdir(), "cyphra-edge-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const configs = (Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig]) as {
  entry?: string[];
  esbuildPlugins?: Plugin[];
}[];
const edgePlugins = configs.find((c) => c.entry?.includes("src/edge.ts"))!.esbuildPlugins!;

/** Workspace packages from source (no build needed), like vitest.config.ts. */
const workspaceSource: Plugin = {
  name: "workspace-source",
  setup(b) {
    b.onResolve({ filter: /^@cyphra\/(schema|query)$/ }, (args) => ({
      path: path.join(monorepo, "packages", args.path.split("/")[1]!, "src/index.ts"),
    }));
  },
};

function inputsOf(meta: Metafile): string[] {
  return Object.keys(meta.inputs);
}

async function bundle(entry: string, plugins: Plugin[], conditions: string[] = []) {
  const outfile = path.join(
    outDir,
    `${path.basename(entry, path.extname(entry))}-${conditions.join("-") || "src"}.mjs`,
  );
  const result = await build({
    stdin: { contents: entry, resolveDir: pkgRoot, loader: "ts", sourcefile: "entry.ts" },
    bundle: true,
    platform: "neutral",
    format: "esm",
    mainFields: ["module", "main"],
    conditions,
    target: "es2022",
    outfile,
    metafile: true,
    logLevel: "silent",
    plugins,
    // Nothing is external: any Node built-in fails to resolve on the neutral platform.
  });
  return { outfile, meta: result.metafile };
}

describe("edge build", () => {
  it("bundles from source with --platform=neutral: no Node built-ins, no neo4j-driver", async () => {
    const { outfile, meta } = await bundle(
      `export { createClient } from "./src/orm/__fixtures__/blog.gen.ts";
       export { CyphraClient, Neo4jHttpError } from "./src/edge.ts";`,
      [workspaceSource, ...edgePlugins],
    );
    const inputs = inputsOf(meta);
    expect(inputs.some((i) => i.includes("neo4j-driver"))).toBe(false);
    expect(inputs.some((i) => /(^|\/)bolt\.ts$/.test(i))).toBe(false);
    expect(inputs.some((i) => i.endsWith("bolt-unavailable.ts"))).toBe(true);
    for (const output of Object.values(meta.outputs)) {
      expect(output.imports.filter((i) => !i.path.startsWith("."))).toEqual([]);
    }

    // The bundle runs the ORM with nothing but `fetch`.
    const mod = (await import(pathToFileURL(outfile).href)) as {
      createClient: (o: object) => {
        user: { findMany(a?: object): Promise<unknown[]> };
        $disconnect(): Promise<void>;
      };
    };
    const urls: string[] = [];
    const db = mod.createClient({
      uri: "https://edge.example",
      user: "neo4j",
      password: "pw",
      fetch: async (url: string) => {
        urls.push(url);
        return new Response(
          JSON.stringify({ data: { fields: ["row"], values: [] }, transaction: { id: "t" } }),
          {
            status: 202,
          },
        );
      },
    });
    expect(await db.user.findMany({ where: { email: "a@x.io" } })).toEqual([]);
    expect(urls[0]).toBe("https://edge.example/db/neo4j/query/v2/tx");
    await db.$disconnect();

    // Bolt is not available in the edge build, with a pointer to the HTTP transport.
    expect(() =>
      mod.createClient({ uri: "neo4j+s://x.databases.neo4j.io", user: "u", password: "p" }),
    ).toThrow(/not available in this runtime.*https:\/\//);
  });

  const dist = path.join(pkgRoot, "dist/edge.js");
  const schemaDist = path.join(monorepo, "packages/schema/dist/index.js");
  it.skipIf(!existsSync(dist) || !existsSync(schemaDist))(
    "resolves @cyphra/runtime to dist/edge.js under the workerd / edge-light conditions",
    async () => {
      for (const condition of ["workerd", "edge-light"]) {
        const { meta } = await bundle(
          `export { CyphraClient, createOrm } from "@cyphra/runtime";`,
          [],
          [condition],
        );
        const inputs = inputsOf(meta);
        expect(inputs.some((i) => /(^|\/)dist\/edge\.js$/.test(i))).toBe(true);
        expect(inputs.some((i) => i.includes("neo4j-driver"))).toBe(false);
      }
    },
  );
});
