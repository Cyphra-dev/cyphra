import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  external: [
    "@cyphra/config",
    "@cyphra/core",
    "@cyphra/migrator",
    "@cyphra/runtime",
    "@cyphra/schema",
    "commander",
  ],
});
