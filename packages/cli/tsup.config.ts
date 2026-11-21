import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  // The shebang comes from src/index.ts (tsup preserves it); a banner would duplicate it.
  external: [
    "@cyphra/graphql",
    "@cyphra/migrator",
    "@cyphra/runtime",
    "@cyphra/schema",
    "commander",
    "graphql",
    "typescript",
  ],
});
