/**
 * The relationship type rename case shared by the Neo4j, Memgraph and FalkorDB migrator suites:
 * `cyphra migrate dev` turns `@out(P_OLD)` into `@out(P_NEW)` and the generated step moves the
 * edges, with their properties, between the two models only.
 */
import { parseSchema, resolveSchema } from "@cyphra/schema";
import type { CyphraClient } from "@cyphra/runtime";
import { expect } from "vitest";
import { diffSchemaModels } from "./diff.js";
import { createMigrationDb } from "./migrationDb.js";

/**
 * Run the case with labels and types starting with `p` (`RenA`, `REN_OLD`, …), on an otherwise
 * empty set of such labels.
 */
export async function renameRelationshipTypeCase(client: CyphraClient, p: string): Promise<void> {
  const run = (text: string) => client.withSession(async (s) => (await s.run(text)).records);
  const [A, B, O, OLD, NEW] = [
    `${p}RenA`,
    `${p}RenB`,
    `${p}RenOther`,
    `${p}REN_OLD`,
    `${p}REN_NEW`,
  ];
  const schema = (t: string) =>
    resolveSchema(
      parseSchema(`node ${A} { id String @id
        bs ${B}[] @out(${t}) }
        node ${B} { id String @id
        a ${A}? @in(${t}) }`),
    );
  await run(`MATCH (n) WHERE n:${A} OR n:${B} OR n:${O} DETACH DELETE n`);
  await run(
    `CREATE (a:${A} {id: 'a'}), (b:${B} {id: 'b'}), (c:${B} {id: 'c'}), (x:${O}), (y:${O}) ` +
      `CREATE (a)-[:${OLD} {since: 1}]->(b), (a)-[:${OLD} {since: 2}]->(c), (x)-[:${OLD} {since: 3}]->(y)`,
  );
  const plan = diffSchemaModels(schema(OLD), schema(NEW));
  expect(plan.steps).toHaveLength(1);
  await client.withSession(async (session) => {
    const db = createMigrationDb(client, session);
    for (const step of plan.steps) if (step.kind === "statement") await db.execute(step.cypher);
  });
  const rows = await run(
    `MATCH (:${A})-[r:${NEW}]->(b:${B}) RETURN b.id AS id, r.since AS since ORDER BY id`,
  );
  expect(rows.map((r) => [r.get("id"), Number(r.get("since"))])).toEqual([
    ["b", 1],
    ["c", 2],
  ]);
  const left = await run(`MATCH (:${A})-[r:${OLD}]->(:${B}) RETURN count(r) AS n`);
  expect(Number(left[0]!.get("n"))).toBe(0);
  // Edges of the old type between other nodes are not touched.
  const other = await run(`MATCH (:${O})-[r:${OLD}]->(:${O}) RETURN r.since AS since`);
  expect(other.map((r) => Number(r.get("since")))).toEqual([3]);
  // The helper of hand-written migrations does the same.
  await client.withSession((session) =>
    createMigrationDb(client, session).migrate.renameRelationshipType({
      from: OLD,
      to: NEW,
      startLabel: O,
    }),
  );
  const moved = await run(`MATCH (:${O})-[r:${NEW}]->(:${O}) RETURN count(r) AS n`);
  expect(Number(moved[0]!.get("n"))).toBe(1);
  await run(`MATCH (n) WHERE n:${A} OR n:${B} OR n:${O} DETACH DELETE n`);
}
