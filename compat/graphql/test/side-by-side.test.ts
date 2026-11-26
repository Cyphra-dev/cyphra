/**
 * `compat.v7` and the native API served side by side from one HTTP server, on one driver and one
 * graph (#77): `/graphql` is the v7 API of fixtures/movies, `/graphql/v2` the native API of
 * native/fixtures/movies (the same graph as schema.cyphra). A frontend can move operation by
 * operation: both answer the same question with the same data.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { compat } from "@cyphra/graphql";
import { graphql, type GraphQLSchema } from "graphql";
import type { Driver } from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "../src/fixtures.js";
import { buildNativeSchema, loadNativeFixture } from "../src/native.js";
import { connect, neo4jEnv, resetAndSeed } from "../src/runner.js";

const env = neo4jEnv();

/** A minimal GraphQL-over-HTTP server routing by path. */
function serve(routes: Record<string, GraphQLSchema>): Server {
  return createServer((req, res) => {
    const schema = routes[req.url ?? ""];
    if (!schema || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", async () => {
      const { query, variables } = JSON.parse(body) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      const result = await graphql({ schema, source: query, variableValues: variables });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    });
  });
}

describe.skipIf(!env)("compat.v7 and native side by side", () => {
  let driver: Driver;
  let server: Server;
  let base: string;

  const post = async (path: string, query: string) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    return (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
  };

  beforeAll(async () => {
    driver = connect(env!);
    const v7 = loadFixture("movies");
    await resetAndSeed(driver, v7.seed);
    const nativeSchema = await buildNativeSchema(loadNativeFixture("movies"), driver);
    const v7Schema = compat.v7.makeSchema({ typeDefs: v7.typeDefs, driver });
    server = serve({ "/graphql": v7Schema, "/graphql/v2": nativeSchema });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await driver?.close();
  });

  it("serves both APIs from one server, on the same graph", async () => {
    const v7 = await post(
      "/graphql",
      `{ movies(where: { released: { gt: 1995 } }, sort: [{ released: ASC }]) { title actors(sort: [{ name: ASC }]) { name } } }`,
    );
    const v2 = await post(
      "/graphql/v2",
      `{ movieFindMany(where: { released: { gt: 1995 } }, orderBy: [{ released: asc }]) { nodes { title actors(orderBy: [{ name: asc }]) { name } } } }`,
    );
    expect(v7.errors).toBeUndefined();
    expect(v2.errors).toBeUndefined();
    expect((v2.data!.movieFindMany as { nodes: unknown }).nodes).toEqual(v7.data!.movies);
  });

  it("reads edge properties as connection properties (v7) and as _edge (native)", async () => {
    const v7 = await post(
      "/graphql",
      `{ movies(where: { id: { eq: "m-matrix" } }) { actorsConnection(sort: [{ node: { name: ASC } }]) { edges { properties { roles } node { name } } } } }`,
    );
    const v2 = await post(
      "/graphql/v2",
      `{ movieFindUnique(where: { id: "m-matrix" }) { actors(orderBy: [{ name: asc }]) { name _edge { roles } } } }`,
    );
    type V7 = {
      movies: {
        actorsConnection: { edges: { properties: { roles: string[] }; node: { name: string } }[] };
      }[];
    };
    const fromV7 = (v7.data as V7).movies[0]!.actorsConnection.edges.map((e) => ({
      name: e.node.name,
      _edge: { roles: e.properties.roles },
    }));
    expect((v2.data!.movieFindUnique as { actors: unknown }).actors).toEqual(fromV7);
  });

  it("keeps each API's own types on its own endpoint", async () => {
    expect((await post("/graphql", `{ movieFindMany { totalCount } }`)).errors).toBeDefined();
    expect((await post("/graphql/v2", `{ movies { title } }`)).errors).toBeDefined();
    const counts = await Promise.all([
      post("/graphql", `{ moviesConnection { totalCount } }`),
      post("/graphql/v2", `{ movieCount }`),
    ]);
    expect((counts[0].data!.moviesConnection as { totalCount: number }).totalCount).toBe(
      counts[1].data!.movieCount,
    );
  });
});
