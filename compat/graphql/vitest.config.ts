import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: {
      // @neo4j/graphql is CommonJS and requires graphql's CJS build; resolve our imports to the
      // same file so there is a single graphql instance (otherwise "from another module or realm").
      graphql: require.resolve("graphql"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    env: { TZ: "UTC" },
    // One Neo4j database is reset between operations: never run files in parallel.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
