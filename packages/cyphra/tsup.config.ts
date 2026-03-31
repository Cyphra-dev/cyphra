import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    query: "src/queryEntry.ts",
    orm: "src/ormEntry.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "@cyphra/config",
    "@cyphra/core",
    "@cyphra/migrator",
    "@cyphra/orm",
    "@cyphra/provider-neo4j",
    "@cyphra/query",
    "@cyphra/runtime",
    "@cyphra/schema",
  ],
});
