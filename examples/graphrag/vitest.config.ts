import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The integration test pushes indexes and ingests documents before its first assertion.
    hookTimeout: 120_000,
  },
});
