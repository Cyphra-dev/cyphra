import type { BetterAuthOptions } from "better-auth/types";
import { CyphraClient } from "@cyphra/runtime";
import { applySchema, connectionFromEnv, hasTestDatabase, wipeDatabase } from "@cyphra/testing";
import { authSchema, type AuthSchemaOptions } from "../src/index.js";

/** `true` when NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD name a test database. */
export const hasNeo4j = hasTestDatabase();

export function testClient(): CyphraClient {
  return new CyphraClient(connectionFromEnv()!);
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
  await wipeDatabase(client, { keepMigrations: false });
}

/** What `cyphra migrate` would create for the auth nodes: constraints and indexes. */
export async function migrate(
  client: CyphraClient,
  options: BetterAuthOptions = {},
  schemaOptions: AuthSchemaOptions = {},
): Promise<void> {
  await applySchema(client, { schema: authSchema(options, schemaOptions).document });
}
