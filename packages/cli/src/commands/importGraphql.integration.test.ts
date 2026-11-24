import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CyphraClient } from "@cyphra/runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runImportGraphql } from "./importGraphql.js";

/**
 * `cyphra import graphql --url` against a live Neo4j: the uniqueness constraints of the database
 * mark the fields they cover. Labels carry a random suffix, so the suite can share the database
 * with other suites; its constraints are dropped at the end.
 */
const enabled = Boolean(
  process.env.NEO4J_TEST_URI &&
  process.env.NEO4J_TEST_USER &&
  process.env.NEO4J_TEST_PASSWORD &&
  process.env.CYPHRA_TEST_DIALECT !== "memgraph" &&
  process.env.CYPHRA_TEST_DIALECT !== "falkordb",
);

const S = Math.random().toString(36).slice(2, 8);
const USER = `ImpUser${S}`;
const ORG = `ImpOrg${S}`;
const SPACE = `ImpSpace${S}`;
const TENANT = `ImpTenant${S}`;

const TYPEDEFS = `
type ${USER} @node {
  id: ID!
  email: String!
  name: String
}

type ${ORG} @node(labels: ["${ORG}", "${TENANT}"]) {
  id: ID!
  region: String!
  code: String!
}

type ${SPACE} @node(labels: ["${SPACE}", "${TENANT}"]) {
  id: ID!
  region: String!
  code: String!
}
`;

const CONSTRAINTS = [
  `CREATE CONSTRAINT imp_user_id_${S} FOR (n:${USER}) REQUIRE n.id IS UNIQUE`,
  `CREATE CONSTRAINT imp_user_email_${S} FOR (n:${USER}) REQUIRE n.email IS UNIQUE`,
  `CREATE CONSTRAINT imp_tenant_id_${S} FOR (n:${TENANT}) REQUIRE n.id IS UNIQUE`,
  `CREATE CONSTRAINT imp_org_code_${S} FOR (n:${ORG}) REQUIRE (n.region, n.code) IS UNIQUE`,
];

describe.skipIf(!enabled)("cyphra import graphql --url (Neo4j)", () => {
  let client: CyphraClient;
  let dir: string;
  let err: string[];
  const run = (text: string) => client.withSession((s) => s.run(text));

  beforeAll(async () => {
    client = new CyphraClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    for (const c of CONSTRAINTS) await run(c);
  });

  afterAll(async () => {
    for (const c of CONSTRAINTS) {
      const name = /CONSTRAINT (\S+)/.exec(c)![1]!;
      await run(`DROP CONSTRAINT ${name} IF EXISTS`);
    }
    await client.close();
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-import-db-"));
    await writeFile(join(dir, "typeDefs.graphql"), TYPEDEFS);
    err = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation((m: unknown) => void err.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void err.push(String(m)));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("marks the fields the constraints cover (credentials in the URL)", async () => {
    const url = new URL(process.env.NEO4J_TEST_URI!);
    url.username = process.env.NEO4J_TEST_USER!;
    url.password = process.env.NEO4J_TEST_PASSWORD!;
    expect(await runImportGraphql(dir, ["typeDefs.graphql"], { url: url.toString() })).toBe(0);
    const schema = await readFile(join(dir, "schema.cyphra"), "utf8");
    expect(schema).toContain(
      `node ${USER} {\n  id String @id\n  email String @unique\n  name String?\n}`,
    );
    expect(schema).toContain(
      `interface ${TENANT} {\n  id String @id\n  region String\n  code String\n}`,
    );
    expect(schema).toContain(`node ${ORG} implements ${TENANT} {\n\n  @@unique([region, code])\n}`);
    const report = err.join("\n");
    expect(report).toContain(`uniqueness constraint imp_user_id_${S} on :${USER}(id): marked @id`);
    expect(report).toContain(
      `uniqueness constraint imp_tenant_id_${S} on :${TENANT}(id): marked @id`,
    );
  });

  it("reads the environment like cyphra pull without a URI", async () => {
    vi.stubEnv("NEO4J_URI", process.env.NEO4J_TEST_URI!);
    vi.stubEnv("NEO4J_USERNAME", process.env.NEO4J_TEST_USER!);
    vi.stubEnv("NEO4J_PASSWORD", process.env.NEO4J_TEST_PASSWORD!);
    try {
      expect(await runImportGraphql(dir, ["typeDefs.graphql"], { url: true })).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
    const schema = await readFile(join(dir, "schema.cyphra"), "utf8");
    expect(schema).toContain("email String @unique");
  });
});
