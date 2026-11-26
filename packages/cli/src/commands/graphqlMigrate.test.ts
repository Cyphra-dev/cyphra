import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expandFiles, extractDocuments } from "./graphqlMigrate.js";
import { runGraphqlCompare } from "./graphqlCompare.js";
import { runGraphqlMigrateOperations } from "./graphqlMigrateOperations.js";
import { runGraphqlMigrateRules } from "./graphqlMigrateRules.js";

const TYPEDEFS = `type Movie @node @authorization(filter: [{ operations: [READ], requireAuthentication: false, where: { node: { published: { eq: true } } } }]) {
  id: ID! @id
  title: String!
  published: Boolean!
  actors: [Person!]! @relationship(type: "ACTED_IN", direction: IN, properties: "ActedIn")
}
type Person @node {
  id: ID! @id
  name: String!
}
type ActedIn @relationshipProperties {
  role: String
}
`;

const GRAPHQL_FILE = `# The movies page.
query Movies {
  movies(where: { title: { eq: "Up" } }, sort: [{ title: ASC }]) {
    title
  }
}
`;

const TS_FILE = `import { gql } from "graphql-tag";
import { doc } from "./doc";

export const ACTORS = gql\`
  query Actors {
    moviesConnection {
      totalCount
      edges { node { title actorsConnection { edges { properties { role } node { name } } } } }
    }
  }
\`;

export const BY_EDGE = doc<{ movies: unknown }>(\`{ movies(where: { actorsConnection: { some: { edge: { role: { eq: "x" } } } } }) { title } }\`);

export const NOT_GRAPHQL = \`select * from movies\`;
const fragment = "f";
export const WITH_FRAGMENT = gql\`query { movies { ...\${fragment} } }\`;
`;

describe("graphql migrate commands", () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-graphql-migrate-"));
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void err.push(String(m)));
    await writeFile(join(dir, "typeDefs.graphql"), TYPEDEFS);
    await writeFile(join(dir, "movies.graphql"), GRAPHQL_FILE);
    await writeFile(join(dir, "actors.ts"), TS_FILE);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("finds documents in .graphql files, gql templates and the given functions", async () => {
    const files = await expandFiles(dir, ["**/*.{graphql,ts}"]);
    expect(files.map((f) => f.slice(dir.length + 1))).toEqual([
      "actors.ts",
      "movies.graphql",
      "typeDefs.graphql",
    ]);
    const docs = extractDocuments("actors.ts", TS_FILE, ["doc"]);
    expect(docs.map((d) => d.text.trim().slice(0, 12))).toEqual([
      "query Actors",
      "{ movies(whe",
      "query { movi",
    ]);
    expect(docs[2]!.skipped).toMatch(/substitutions/);
    expect(extractDocuments("actors.ts", TS_FILE)).toHaveLength(2);
  });

  it("rewrites the documents it can translate and reports the others with their location", async () => {
    const code = await runGraphqlMigrateOperations(dir, ["movies.graphql", "actors.ts"], {
      typedefs: ["typeDefs.graphql"],
      tag: ["doc"],
    });
    expect(code).toBe(0);
    expect(await readFile(join(dir, "movies.graphql"), "utf8")).toBe(`# The movies page.
query Movies {
  movieFindMany(where: {title: {equals: "Up"}}, orderBy: [{title: asc}]) {
    nodes {
      title
    }
  }
}
`);
    const ts = await readFile(join(dir, "actors.ts"), "utf8");
    expect(ts).toContain(`export const ACTORS = gql\`
  query Actors {
    movieFindMany {
      nodes {
        title
        actors {
          name
          _edge {
            role
          }
        }
      }
      totalCount
    }
  }
\`;`);
    expect(ts).toContain(
      "doc<{ movies: unknown }>(`# cyphra: not translated: movies(where).actorsConnection.some.edge: the native API has no filters on edge properties",
    );
    const report = out.join("\n");
    expect(report).toMatch(/^actors\.ts:13:\d+ +NOT TRANSLATED/m);
    expect(report).toMatch(
      /actors\.ts:13:\d+ +cannot translate: movies\(where\)\.actorsConnection\.some\.edge/,
    );
    expect(report).toMatch(/actors\.ts:17:\d+ +skipped/);
    expect(report).toMatch(
      /4 documents in 2 files: 2 translated, 1 not translated, 1 skipped\. 2 files rewritten\./,
    );
    // Run again: nothing left to translate, the comments stay as they are.
    out = [];
    await runGraphqlMigrateOperations(dir, ["movies.graphql", "actors.ts"], {
      typedefs: ["typeDefs.graphql"],
      tag: ["doc"],
    });
    expect(await readFile(join(dir, "actors.ts"), "utf8")).toBe(ts);
    expect(out.join("\n")).toMatch(/2 already native/);
  });

  it("--dry-run writes nothing, --check fails while v7 operations are left", async () => {
    expect(
      await runGraphqlMigrateOperations(dir, ["movies.graphql"], {
        typedefs: ["typeDefs.graphql"],
        dryRun: true,
      }),
    ).toBe(0);
    expect(await readFile(join(dir, "movies.graphql"), "utf8")).toBe(GRAPHQL_FILE);
    expect(out.join("\n")).toContain("  |   movieFindMany(");
    expect(
      await runGraphqlMigrateOperations(dir, ["movies.graphql"], {
        typedefs: ["typeDefs.graphql"],
        check: true,
      }),
    ).toBe(1);
    expect(await readFile(join(dir, "movies.graphql"), "utf8")).toBe(GRAPHQL_FILE);
    await runGraphqlMigrateOperations(dir, ["movies.graphql"], { typedefs: ["typeDefs.graphql"] });
    expect(
      await runGraphqlMigrateOperations(dir, ["movies.graphql"], {
        typedefs: ["typeDefs.graphql"],
        check: true,
      }),
    ).toBe(0);
  });

  it("--json reports every document", async () => {
    await runGraphqlMigrateOperations(dir, ["actors.ts"], {
      typedefs: ["typeDefs.graphql"],
      json: true,
      dryRun: true,
    });
    const report = JSON.parse(out.join("\n")) as {
      summary: Record<string, unknown>;
      documents: { status: string }[];
    };
    expect(report.documents.map((d) => d.status)).toEqual(["translated", "skipped"]);
    expect(report.summary.translated).toBe(1);
  });

  it("migrate-rules writes a draft and counts drafted and TODO rules", async () => {
    const code = await runGraphqlMigrateRules(dir, ["typeDefs.graphql"], { out: "rules.ts" });
    expect(code).toBe(0);
    const draft = await readFile(join(dir, "rules.ts"), "utf8");
    expect(draft).toContain(`read: () => ({ published: { equals: true } }),`);
    expect(out.join("\n")).toMatch(
      /Wrote rules\.ts\. 1 v7 rule: 1 drafted, 0 partly drafted, 0 TODO\./,
    );
  });
});

describe("graphql compare over HTTP", () => {
  let dir: string;
  let out: string[];
  const servers: Server[] = [];

  /** An endpoint answering every request with `data`. */
  async function endpoint(data: Record<string, unknown>): Promise<string> {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () =>
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data })),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-graphql-compare-"));
    out = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await writeFile(join(dir, "typeDefs.graphql"), TYPEDEFS);
    await writeFile(join(dir, "movies.graphql"), GRAPHQL_FILE);
    await writeFile(
      join(dir, "create.graphql"),
      `mutation { createPeople(input: [{ name: "Ed" }]) { people { name } } }`,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it("maps the v7 result to the native shape and reports differences", async () => {
    const v7Url = await endpoint({ movies: [{ title: "Up" }] });
    const same = await endpoint({ movieFindMany: { nodes: [{ title: "Up" }] } });
    const other = await endpoint({ movieFindMany: { nodes: [{ title: "Cars" }] } });
    const opts = { typedefs: ["typeDefs.graphql"], v7Url };
    expect(
      await runGraphqlCompare(dir, ["movies.graphql", "create.graphql"], {
        ...opts,
        nativeUrl: same,
      }),
    ).toBe(0);
    expect(out.join("\n")).toMatch(/movies\.graphql:2:1 +same +Movies/);
    expect(out.join("\n")).toMatch(/create\.graphql:1:1 +skipped .*--allow-mutations/);
    out = [];
    expect(await runGraphqlCompare(dir, ["movies.graphql"], { ...opts, nativeUrl: other })).toBe(1);
    expect(out.join("\n")).toContain(`movieFindMany.nodes[0].title: v7 "Up", native "Cars"`);
  });
});
