import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/config",
    "packages/core",
      "packages/schema",
      "packages/query",
      "packages/provider-neo4j",
      "packages/runtime",
      "packages/orm",
      "packages/migrator",
      "packages/cli",
      "packages/cyphra",
    ],
  },
});
