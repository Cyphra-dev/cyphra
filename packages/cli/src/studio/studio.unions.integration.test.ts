import { CyphraClient, createOrm } from "@cyphra/runtime";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientForConfig } from "../clientFromEnv.js";
import { createStudioApi, type StudioApi } from "./api.js";
import { createStudioDb } from "./db.js";
import type { EdgeFindResponse, FindResponse } from "./protocol.js";
import { buildMeta } from "./values.js";

/**
 * The studio API on relations to a union (with an interface member and a typed edge), through the
 * real ORM, on the test database of `CYPHRA_TEST_DIALECT`: Neo4j (default), Memgraph (detected
 * from the server) or FalkorDB (its own graph). Labels are prefixed with `Su`.
 */
const falkordb = process.env.CYPHRA_TEST_DIALECT === "falkordb";
const enabled = falkordb
  ? Boolean(process.env.FALKORDB_TEST_URL)
  : Boolean(
      process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
    );

const schema = resolveSchema(
  parseSchema(`
union SuHit = SuPost | SuPerson

interface SuPerson {
  id    String @id
  email String @unique
}

node SuWriter implements SuPerson {
  name String
}

node SuPost {
  id    String @id
  title String
}

node SuBoard {
  id    String  @id
  hits  SuHit[] @relationship(type: "SU_PINS", direction: OUT)
  first SuHit?  @relationship(type: "SU_TOPS", direction: OUT)
}

relationship SuPin {
  type "SU_PINS"
  from SuBoard
  to   SuHit
  rank Int @default(0)
}
`),
);

const ENV = falkordb
  ? ["FALKORDB_URL", "FALKORDB_GRAPH"]
  : ["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD", "NEO4J_DATABASE"];

describe.skipIf(!enabled)("studio API: relations to a union", () => {
  let client: CyphraClient;
  let api: StudioApi;
  const saved: Record<string, string | undefined> = {};
  const wipe = () =>
    client.withSession((s) =>
      s.run("MATCH (n) WHERE n:SuBoard OR n:SuPost OR n:SuWriter OR n:SuPerson DETACH DELETE n"),
    );
  const ok = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await api.handle("POST", path, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as T;
  };

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    if (falkordb) {
      process.env.FALKORDB_URL = process.env.FALKORDB_TEST_URL;
      process.env.FALKORDB_GRAPH = "cyphra_studio_union_test";
    } else {
      process.env.NEO4J_URI = process.env.NEO4J_TEST_URI;
      process.env.NEO4J_USERNAME = process.env.NEO4J_TEST_USER;
      process.env.NEO4J_PASSWORD = process.env.NEO4J_TEST_PASSWORD;
      delete process.env.NEO4J_DATABASE;
    }
    client = await clientForConfig(falkordb ? { dialect: "falkordb" } : {});
    await wipe();
    const orm = createOrm(schema, { client }) as unknown as Record<string, unknown>;
    const meta = buildMeta(schema, {
      connection: "test",
      version: "0.0.0",
      dialect: client.dialect,
      readOnly: false,
    });
    api = createStudioApi({ schema, db: createStudioDb(orm, client), meta, readOnly: false });
  });

  afterAll(async () => {
    if (!client) return;
    await wipe();
    await client.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("links and unlinks by member, edits edge properties and lists the edges", async () => {
    await ok("/api/models/SuBoard/create", { data: { id: "b" } });
    await ok("/api/models/SuPost/create", { data: { id: "p", title: "Graphs" } });
    await ok("/api/models/SuWriter/create", { data: { id: "w", email: "w@x.io", name: "Wen" } });

    // Through the interface member's key, and through a node member with edge properties.
    await ok("/api/models/SuBoard/connect", {
      where: { id: "b" },
      relation: "hits",
      member: "SuPerson",
      key: { email: "w@x.io" },
    });
    await ok("/api/models/SuBoard/connect", {
      where: { id: "b" },
      relation: "hits",
      member: "SuPost",
      key: { id: "p" },
      edge: { rank: 2 },
    });
    await ok("/api/models/SuBoard/connect", {
      where: { id: "b" },
      relation: "first",
      member: "SuWriter",
      key: { id: "w" },
    });
    const related = await ok<FindResponse>("/api/models/SuBoard/related", {
      where: { id: "b" },
      relation: "hits",
      orderBy: {},
    });
    expect(
      related.rows
        .map((r) => [r.__typename, (r.$edge as { rank: number }).rank])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["SuPost", 2],
      ["SuWriter", 0],
    ]);

    // The edges of the relationship model, each end with its member key.
    const edges = await ok<EdgeFindResponse>("/api/relationships/SuPin/find", {
      orderBy: { rank: "desc" },
    });
    expect(edges.total).toBe(2);
    expect(edges.rows.map((r) => [r.to, r.properties.rank])).toEqual([
      [{ __typename: "SuPost", id: "p" }, 2],
      [{ __typename: "SuWriter", id: "w" }, 0],
    ]);
    await ok("/api/relationships/SuPin/update", {
      from: { id: "b" },
      to: { id: "w" },
      toMember: "SuWriter",
      data: { rank: 7 },
    });
    const counts = await api.handle("GET", "/api/counts", undefined);
    expect(counts.body).toMatchObject({ SuHit: 2, SuPin: 2 });

    await ok("/api/models/SuBoard/disconnect", {
      where: { id: "b" },
      relation: "hits",
      member: "SuPost",
      key: { id: "p" },
    });
    await ok("/api/models/SuBoard/disconnect", { where: { id: "b" }, relation: "first" });
    const left = await ok<EdgeFindResponse>("/api/relationships/SuPin/find", {});
    expect(left.rows.map((r) => [r.to, r.properties.rank])).toEqual([
      [{ __typename: "SuWriter", id: "w" }, 7],
    ]);
    const board = await ok<FindResponse>("/api/models/SuBoard/find", {});
    expect(board.rows[0]).toMatchObject({ id: "b", first: null, _count: { hits: 1 } });
  });
});
