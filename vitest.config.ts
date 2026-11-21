import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/schema",
      "packages/query",
      "packages/runtime",
      "packages/migrator",
      "packages/cli",
      "packages/cyphra",
      "packages/better-auth",
      "packages/graphql",
      "packages/language-server",
      "packages/vscode",
      "compat/graphql",
    ],
  },
});
