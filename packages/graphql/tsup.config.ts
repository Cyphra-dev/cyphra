import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@cyphra/runtime", "@cyphra/schema", "graphql", "neo4j-driver", "pluralize"],
});
