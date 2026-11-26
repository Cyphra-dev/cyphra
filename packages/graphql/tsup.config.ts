import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", native: "src/native/index.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@cyphra/runtime", "@cyphra/schema", "graphql", "neo4j-driver", "pluralize"],
});
