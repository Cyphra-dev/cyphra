import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  resolve: {
    alias: {
      "@cyphra/schema": path.join(monorepoRoot, "packages/schema/src/index.ts"),
      "@cyphra/query": path.join(monorepoRoot, "packages/query/src/index.ts"),
      "@cyphra/runtime": path.join(monorepoRoot, "packages/runtime/src/index.ts"),
      "@cyphra/migrator": path.join(monorepoRoot, "packages/migrator/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
