import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  sourcemap: true,
  clean: true,
  // The shebang comes from src/bin.ts (tsup preserves it and makes the file executable).
  external: ["@cyphra/schema", "vscode-languageserver", "vscode-languageserver-textdocument"],
});
