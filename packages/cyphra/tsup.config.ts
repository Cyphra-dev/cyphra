import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "@cyphra/migrator",
    "@cyphra/query",
    "@cyphra/runtime",
    "@cyphra/schema",
    "neo4j-driver",
  ],
});
