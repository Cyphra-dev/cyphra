import { CyphraClient, createOrm } from "@cyphra/runtime";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientForConfig } from "../clientFromEnv.js";
import { createStudioApi, type StudioApi } from "./api.js";
import { createStudioDb } from "./db.js";
import { buildMeta } from "./values.js";

/**
 * The studio API against FalkorDB (`"dialect": "falkordb"`), through the real ORM, on its own
 * graph (`cyphra_studio_test`).
 */
const enabled =
  process.env.CYPHRA_TEST_DIALECT === "falkordb" && Boolean(process.env.FALKORDB_TEST_URL);

const schema = resolveSchema(
  parseSchema(`
node SfkUser {
  id    String  @id
  email String  @unique
  name  String
  born  Date?
  home  Point?
  posts SfkPost[] @relationship(type: "SFK_AUTHORED", direction: OUT)
}

node SfkPost {
  id     String   @id
  title  String
  author SfkUser? @relationship(type: "SFK_AUTHORED", direction: IN)
}
`),
);

describe.skipIf(!enabled)("studio API (FalkorDB)", () => {
  let client: CyphraClient;
  let api: StudioApi;
  const saved: Record<string, string | undefined> = {};
  const post = (path: string, body: unknown) => api.handle("POST", path, body);

  beforeAll(async () => {
    for (const k of ["FALKORDB_URL", "FALKORDB_GRAPH"]) saved[k] = process.env[k];
    process.env.FALKORDB_URL = process.env.FALKORDB_TEST_URL;
    process.env.FALKORDB_GRAPH = "cyphra_studio_test";
    client = await clientForConfig({ dialect: "falkordb" });
    await client.withSession((s) => s.run("MATCH (n) DETACH DELETE n"));
    const orm = createOrm(schema, { client }) as unknown as Record<string, unknown>;
    const meta = buildMeta(schema, {
      connection: "redis://test",
      version: "0.0.0",
      dialect: client.dialect,
      readOnly: false,
    });
    api = createStudioApi({ schema, db: createStudioDb(orm, client), meta, readOnly: false });
  });

  afterAll(async () => {
    if (!client) return;
    await client.withSession((s) => s.run("MATCH (n) DETACH DELETE n"));
    await client.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("exposes FalkorDB in the meta and marks the fields it cannot store", async () => {
    expect(client.dialect).toBe("falkordb");
    const res = await api.handle("GET", "/api/meta", undefined);
    expect(res.body).toMatchObject({ dialect: "falkordb" });
    const meta = res.body as { nodes: { name: string; fields: { name: string }[] }[] };
    const user = meta.nodes.find((n) => n.name === "SfkUser")!;
    expect(user.fields.find((f) => f.name === "home")).toHaveProperty("unsupported");
    expect(user.fields.find((f) => f.name === "born")).not.toHaveProperty("unsupported");
    const point = await post("/api/models/SfkUser/create", {
      data: { id: "x", email: "x@x.io", name: "X", home: { longitude: 2, latitude: 48 } },
    });
    expect(point.status).toBe(400);
    expect(point.body).toMatchObject({
      error: expect.stringMatching(/cannot be written on FalkorDB/),
      unsupported: { dialect: "falkordb" },
    });
  });

  it("creates, lists, updates and deletes records, and runs Cypher", async () => {
    const created = await post("/api/models/SfkUser/create", {
      data: { id: "u1", email: "ada@x.io", name: "Ada", born: "1815-12-10" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect((created.body as { row: unknown }).row).toMatchObject({
      id: "u1",
      born: "1815-12-10T00:00:00.000Z",
    });
    const p = await post("/api/models/SfkPost/create", {
      data: { id: "p1", title: "Engines" },
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const link = await post("/api/cypher", {
      query: "MATCH (u:SfkUser {id: 'u1'}), (p:SfkPost {id: 'p1'}) CREATE (u)-[:SFK_AUTHORED]->(p)",
      write: true,
    });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const found = await post("/api/models/SfkUser/find", { where: { name: "Ada" } });
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(JSON.stringify(found.body)).toContain("ada@x.io");
    const updated = await post("/api/models/SfkUser/update", {
      where: { id: "u1" },
      data: { name: "Ada L." },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const cypher = await post("/api/cypher", {
      query:
        "MATCH (u:SfkUser)-[:SFK_AUTHORED]->(p:SfkPost) RETURN u.name AS name, p.title AS title",
    });
    expect(cypher.status, JSON.stringify(cypher.body)).toBe(200);
    expect(JSON.stringify(cypher.body)).toContain("Ada L.");
    const deleted = await post("/api/models/SfkUser/delete", { where: { id: "u1" } });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  });
});
