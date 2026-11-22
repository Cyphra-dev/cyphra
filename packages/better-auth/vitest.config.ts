import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  resolve: {
    alias: {
      "@cyphra/query": path.join(monorepoRoot, "packages/query/src/index.ts"),
      "@cyphra/schema": path.join(monorepoRoot, "packages/schema/src/index.ts"),
      "@cyphra/runtime": path.join(monorepoRoot, "packages/runtime/src/index.ts"),
      "@cyphra/migrator": path.join(monorepoRoot, "packages/migrator/src/index.ts"),
      "@cyphra/testing": path.join(monorepoRoot, "packages/testing/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Integration files share one Neo4j database and reset it, so they run one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
