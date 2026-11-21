import type { BetterAuthOptions } from "better-auth/types";
import { CyphraClient } from "@cyphra/runtime";
import { constraintStatementsFromSchema, indexStatementsFromSchema } from "@cyphra/migrator";
import { authSchema, type AuthSchemaOptions } from "../src/index.js";

export const hasNeo4j = Boolean(
  process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
);

export function testClient(): CyphraClient {
  return new CyphraClient({
    uri: process.env.NEO4J_TEST_URI!,
    user: process.env.NEO4J_TEST_USER!,
    password: process.env.NEO4J_TEST_PASSWORD!,
  });
}

export async function run(
  client: CyphraClient,
  text: string,
  params: Record<string, unknown> = {},
): Promise<{ get(key: string): unknown }[]> {
  return client.withWriteTransaction(async (tx) => (await tx.run(text, params)).records);
}

/** Remove every node (constraints are kept). */
export async function resetDatabase(client: CyphraClient): Promise<void> {
  await run(client, "MATCH (n) DETACH DELETE n");
}

/** What `cyphra migrate` would create for the auth nodes: constraints and indexes. */
export async function migrate(
  client: CyphraClient,
  options: BetterAuthOptions = {},
  schemaOptions: AuthSchemaOptions = {},
): Promise<void> {
  const { document } = authSchema(options, schemaOptions);
  for (const statement of [
    ...constraintStatementsFromSchema(document),
    ...indexStatementsFromSchema(document),
  ]) {
    await client.withSession((session) => session.run(statement));
  }
}
