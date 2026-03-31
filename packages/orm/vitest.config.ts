import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  resolve: {
    alias: {
      "@cyphra/query": path.join(monorepoRoot, "packages/query/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
