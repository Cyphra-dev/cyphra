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
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Integration files share one database and wipe the `Tst*` nodes, so they run one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    // A container start (image pull, plugin download) can take minutes.
    hookTimeout: 300_000,
  },
});
