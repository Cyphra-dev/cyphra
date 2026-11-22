import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  resolve: {
    alias: {
      cyphra: path.join(monorepoRoot, "packages/cyphra/src/index.ts"),
      "@cyphra/query": path.join(monorepoRoot, "packages/query/src/index.ts"),
      "@cyphra/schema": path.join(monorepoRoot, "packages/schema/src/index.ts"),
      "@cyphra/runtime": path.join(monorepoRoot, "packages/runtime/src/index.ts"),
      "@cyphra/migrator": path.join(monorepoRoot, "packages/migrator/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["reflect-metadata"],
    // The integration file shares one Neo4j database with the other suites' labels: one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
