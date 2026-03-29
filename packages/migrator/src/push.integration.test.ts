import { describe, expect, it } from "vitest";
import { parseSchema } from "@cyphra/schema";
import { CyphraClient } from "@cyphra/runtime";
import { constraintStatementsFromSchema, indexStatementsFromSchema } from "./push.js";
import { applyConstraintStatements } from "./runner.js";

const hasNeo = Boolean(
  process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
);

describe.skipIf(!hasNeo)("push DDL integration (Neo4j)", () => {
  it("applies constraint + index statements idempotently", async () => {
    const doc = parseSchema(`
      node CyphraPushSmoke {
        id   String @id
        slug String @index
      }
    `);
    const stmts = [...constraintStatementsFromSchema(doc), ...indexStatementsFromSchema(doc)];
    expect(stmts.length).toBe(2);

    const client = new CyphraClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    try {
      await applyConstraintStatements(client, stmts);
      await applyConstraintStatements(client, stmts);
    } finally {
      await client.close();
    }
  });
});
