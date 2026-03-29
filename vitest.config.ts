import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/schema",
      "packages/query",
      "packages/runtime",
      "packages/migrator",
      "packages/cli",
    ],
  },
});
