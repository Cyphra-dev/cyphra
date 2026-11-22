import { defineConfig, type Options } from "tsup";
import { fileURLToPath } from "node:url";

const shared: Options = {
  format: ["esm"],
  sourcemap: true,
  // Cleaned by the `build` script: the two builds run in parallel.
  clean: false,
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    dts: true,
    external: ["@cyphra/query", "@cyphra/schema", "neo4j-driver", "falkordb"],
  },
  {
    // Edge build: `bolt.ts` (the only module that loads `neo4j-driver`) is replaced by a stub,
    // so the bundle imports no Node built-in (checked by `edge.test.ts`).
    ...shared,
    entry: ["src/edge.ts"],
    dts: false,
    external: ["@cyphra/query", "@cyphra/schema"],
    esbuildPlugins: [
      {
        name: "cyphra-edge-no-bolt",
        setup(build) {
          build.onResolve({ filter: /^\.\/bolt\.js$/ }, () => ({
            path: fileURLToPath(new URL("./src/bolt-unavailable.ts", import.meta.url)),
          }));
          // FalkorDB needs TCP sockets too: its loader is replaced by one that throws.
          build.onResolve({ filter: /^\.\/load\.js$/ }, (args) =>
            /[\\/]falkordb$/.test(args.resolveDir)
              ? {
                  path: fileURLToPath(
                    new URL("./src/falkordb/load-unavailable.ts", import.meta.url),
                  ),
                }
              : undefined,
          );
          build.onResolve({ filter: /^neo4j-driver$/ }, () => ({
            errors: [{ text: "neo4j-driver must not be bundled in the edge build" }],
          }));
        },
      },
    ],
  },
]);
