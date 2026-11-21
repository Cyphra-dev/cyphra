/**
 * Better Auth's official adapter conformance suites, against a real Neo4j
 * (NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD; skipped when unset).
 */
import { describe, it } from "vitest";
import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  joinsTestSuite,
  normalTestSuite,
  testAdapter,
  transactionsTestSuite,
  uuidTestSuite,
} from "@better-auth/test-utils/adapter";
import { cyphraAdapter } from "../src/index.js";
import { hasNeo4j, migrate, resetDatabase, testClient } from "./helpers.js";

if (hasNeo4j) {
  const client = testClient();
  await resetDatabase(client);

  const { execute } = await testAdapter({
    adapter: async () => cyphraAdapter({ client }),
    runMigrations: (options) => migrate(client, options),
    tests: [
      normalTestSuite(),
      caseInsensitiveTestSuite(),
      transactionsTestSuite(),
      joinsTestSuite(),
      uuidTestSuite(),
      authFlowTestSuite(),
    ],
    onFinish: async () => {
      await client.close();
    },
  });
  execute();
} else {
  describe.skip("Better Auth conformance suite (needs NEO4J_TEST_*)", () => {
    it("runs against Neo4j", () => {});
  });
}
