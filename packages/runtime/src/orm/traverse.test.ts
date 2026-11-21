import { describe, expect, it } from "vitest";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { schemaModel } from "./__fixtures__/blog.gen.js";
import { schemaModel as graphSchema } from "./__fixtures__/graph.gen.js";
import { QueryContext } from "./compile.js";
import { CyphraValidationError } from "./errors.js";
import { decodePath } from "./path.js";
import { compileTraverse, parseDepth } from "./traverse.js";

const user = schemaModel.nodes.find((n) => n.name === "User")!;
const post = schemaModel.nodes.find((n) => n.name === "Post")!;
const SCALARS = "n{.`id`, .`email`, .`name`, .`age`, .`tags`, .`createdAt`}";

function traverse(args: Record<string, unknown>, max = 10) {
  return compileTraverse(new QueryContext(schemaModel), user, args, max);
}

describe("compileTraverse", () => {
  it("compiles a quantified path pattern with parameterized filters", () => {
    const c = traverse({
      from: { id: "u1" },
      via: "following",
      depth: { min: 1, max: 3 },
      where: { age: { gte: 18 } },
    });
    expect(c.text).toBe(
      "MATCH (s:`User`) WHERE s.`id` = $p0 " +
        "MATCH (s)((:`User`)-[e0:`FOLLOWS`]->(:`User`)){1,3}(n:`User`) " +
        "WHERE (n <> s) AND (n.`age` >= $p1) " +
        `WITH DISTINCT n RETURN ${SCALARS} AS row`,
    );
    expect(c.params.p0).toBe("u1");
    expect((c.params.p1 as { toNumber(): number }).toNumber()).toBe(18);
  });

  it("follows the declared direction, or the one given", () => {
    expect(traverse({ from: {}, via: "followers", depth: { max: 2 } }).text).toContain(
      "((:`User`)<-[e0:`FOLLOWS`]-(:`User`)){1,2}",
    );
    expect(
      traverse({ from: {}, via: "followers", direction: "out", depth: { max: 2 } }).text,
    ).toContain("((:`User`)-[e0:`FOLLOWS`]->(:`User`)){1,2}");
    expect(
      traverse({ from: {}, via: "following", direction: "both", depth: { max: 2 } }).text,
    ).toContain("((:`User`)-[e0:`FOLLOWS`]-(:`User`)){1,2}");
    // Both sides of one relationship type: either direction.
    expect(
      traverse({ from: {}, via: ["following", "followers"], depth: { max: 2 } }).text,
    ).toContain("((:`User`)-[e0:`FOLLOWS`]-(:`User`)){1,2}");
  });

  it("constrains each relationship type to its own direction when directions differ", () => {
    const schema = resolveSchema(
      parseSchema(`
        node Person {
          id      String   @id
          manages Person[] @relationship(type: "MANAGES", direction: OUT)
          mentors Person[] @relationship(type: "MENTORS", direction: IN)
          knows   Person[] @relationship(type: "KNOWS", direction: OUT)
        }
      `),
    );
    const person = schema.nodes[0]!;
    const c = compileTraverse(
      new QueryContext(schema),
      person,
      { from: { id: "p" }, via: ["manages", "mentors"], depth: { max: 2 } },
      10,
    );
    expect(c.text).toContain(
      "MATCH (s)((x1:`Person`)-[e0:`MANAGES`|`MENTORS`]-(y2:`Person`) " +
        "WHERE ((type(e0) = $p1 AND startNode(e0) = x1) OR (type(e0) = $p2 AND endNode(e0) = x1))){1,2}(n:`Person`)",
    );
    expect([c.params.p1, c.params.p2]).toEqual(["MANAGES", "MENTORS"]);
    // An untyped edge has no properties to filter.
    expect(() =>
      compileTraverse(
        new QueryContext(schema),
        person,
        { from: {}, via: "knows", depth: { max: 2 }, edgeWhere: {} },
        10,
      ),
    ).toThrow(/edgeWhere/);
  });

  it("filters edge properties inside the pattern", () => {
    const since = new Date("2024-01-01T00:00:00Z");
    const c = traverse({
      from: { email: "a@x.io" },
      via: "following",
      depth: { max: 2 },
      edgeWhere: { since: { gte: since } },
    });
    expect(c.text).toContain(
      "MATCH (s)((:`User`)-[e0:`FOLLOWS`]->(:`User`) WHERE (e0.`since` >= $p1)){1,2}(n:`User`)",
    );
    expect(String(c.params.p1)).toBe("2024-01-01T00:00:00Z");
  });

  it("depth.min 0 keeps the start node; distinct false keeps every path", () => {
    const c = traverse({ from: { id: "u1" }, via: "following", depth: { min: 0, max: 1 } });
    expect(c.text).toContain("{0,1}(n:`User`) WITH DISTINCT n");
    expect(c.text).not.toContain("n <> s");
    const all = traverse({
      from: { id: "u1" },
      via: "following",
      depth: { max: 2 },
      distinct: false,
    });
    expect(all.text).toContain("WHERE (n <> s) WITH n RETURN");
  });

  it("pages and orders the reached nodes", () => {
    const c = traverse({
      from: { id: "u1" },
      via: "following",
      depth: { max: 3 },
      orderBy: { email: "asc" },
      skip: 1,
      take: 2,
      select: { email: true },
    });
    expect(c.text).toContain(
      "WITH DISTINCT n ORDER BY n.`email` ASC SKIP $p1 LIMIT $p2 RETURN n{.`email`} AS row ORDER BY n.`email` ASC",
    );
  });

  it("returns one shortest path per reached node with returnPaths", () => {
    const c = traverse({
      from: { id: "u1" },
      via: "following",
      depth: { max: 3 },
      returnPaths: true,
    });
    expect(c.text).toContain("MATCH p = (s)((:`User`)-[e0:`FOLLOWS`]->(:`User`)){1,3}(n:`User`)");
    expect(c.text).toContain(
      "WITH n, collect(p) AS ps, min(length(p)) AS d WITH n, [x1 IN ps WHERE length(x1) = d][0] AS p",
    );
    expect(c.text).toContain(
      "AS row, {nodes: [x2 IN nodes(p) | {labels: labels(x2), properties: properties(x2)}], " +
        "edges: [i3 IN range(0, length(p) - 1) | {type: type(relationships(p)[i3]), " +
        "properties: properties(relationships(p)[i3]), out: startNode(relationships(p)[i3]) = nodes(p)[i3]}]} AS path",
    );
    const all = traverse({
      from: { id: "u1" },
      via: "following",
      depth: { max: 3 },
      returnPaths: true,
      distinct: false,
    });
    expect(all.text).toContain("WITH n, p RETURN");
  });

  it("rejects unknown relations, missing or excessive depth and bad options", () => {
    const bad = (args: Record<string, unknown>, max?: number) =>
      expect(() => traverse(args, max)).toThrow(CyphraValidationError);
    const base = { from: { id: "u1" }, via: "following", depth: { max: 2 } };
    bad({ ...base, via: "friends" });
    bad({ ...base, via: "posts" }); // leads to Post
    bad({ ...base, via: [] });
    bad({ ...base, via: undefined });
    bad({ ...base, depth: undefined });
    bad({ ...base, depth: { min: 1 } });
    bad({ ...base, depth: { max: 0 } });
    bad({ ...base, depth: { max: 1.5 } });
    bad({ ...base, depth: { min: 3, max: 2 } });
    bad({ ...base, depth: { max: 2, maxx: 3 } });
    bad({ ...base, depth: { max: 11 } });
    bad({ ...base, depth: { max: 4 } }, 3);
    bad({ ...base, from: undefined });
    bad({ ...base, direction: "up" });
    bad({ ...base, edgeWhere: { weight: 1 } });
    bad({ ...base, distinct: "yes" });
    bad({ ...base, returnPaths: 1 });
    bad({ ...base, wher: {} });
    bad({ ...base, where: { nope: 1 } });
    expect(() =>
      compileTraverse(
        new QueryContext(schemaModel),
        post,
        { from: {}, via: "author", depth: { max: 1 } },
        10,
      ),
    ).toThrow(/leads to User/);
    expect(() => traverse({ ...base, depth: { max: 11 } })).toThrow(/maxTraversalDepth/);
  });

  it("parses depth with min defaulting to 1", () => {
    expect(parseDepth({ max: 3 }, 10)).toEqual({ min: 1, max: 3 });
    expect(parseDepth({ min: 0, max: 10 }, 10)).toEqual({ min: 0, max: 10 });
  });
});

describe("decodePath", () => {
  it("decodes nodes by label and edges by relationship model, without driver classes", () => {
    const since = { toStandardDate: () => new Date("2024-01-02T00:00:00Z") };
    const path = decodePath(schemaModel, {
      nodes: [
        { labels: ["User"], properties: { id: "a", email: "a@x.io", extra: 1 } },
        { labels: ["User"], properties: { id: "b", email: "b@x.io", tags: ["x"] } },
        { labels: ["Unknown"], properties: { k: "v" } },
      ],
      edges: [
        { type: "FOLLOWS", properties: { since }, out: true },
        { type: "OTHER", properties: { w: 1 }, out: false },
      ],
    });
    expect(path.nodes[0]).toEqual({
      id: "a",
      email: "a@x.io",
      name: null,
      age: null,
      tags: [],
      createdAt: null,
    });
    expect(path.nodes[1]!.tags).toEqual(["x"]);
    expect(path.nodes[2]).toEqual({ k: "v" });
    expect(path.edges[0]!.type).toBe("FOLLOWS");
    expect(path.edges[0]!.direction).toBe("out");
    expect(path.edges[1]).toEqual({ type: "OTHER", direction: "in", properties: {} });
  });
});

describe("compileTraverse with a list of hops", () => {
  const chunk = graphSchema.nodes.find((n) => n.name === "GrChunk")!;
  const hops = (args: Record<string, unknown>, max = 10) =>
    compileTraverse(new QueryContext(graphSchema), chunk, args, max);

  it("chains one quantified path pattern per hop, across models", () => {
    const c = hops({
      from: { id: "c1" },
      via: [
        { rel: "entities", where: { kind: "person" } },
        { rel: "related", direction: "both", depth: { min: 0, max: 2 } },
        { rel: "chunks" },
      ],
      where: { draft: false },
      select: { id: true },
    });
    expect(c.text).toBe(
      "MATCH (s:`GrChunk`) WHERE s.`id` = $p0 " +
        "MATCH (s)((:`GrChunk`)-[e0:`GR_MENTIONS`]->(t1:`GrEntity`) WHERE (t1.`kind` = $p1)){1,1}" +
        "((:`GrEntity`)-[e2:`GR_RELATED`]-(:`GrEntity`)){0,2}" +
        "((:`GrEntity`)<-[e3:`GR_MENTIONS`]-(:`GrChunk`)){1,1}(n:`GrChunk`) " +
        "WHERE (n <> s) AND (n.`draft` = $p2) " +
        "WITH DISTINCT n RETURN n{.`id`} AS row",
    );
    expect(c.params).toMatchObject({ p0: "c1", p1: "person", p2: false });
  });

  it("filters each hop's edges with its own relationship model, and nodes with relation filters", () => {
    const c = hops({
      from: {},
      via: [
        { rel: "entities", edgeWhere: { count: { gte: 2 } } },
        {
          rel: "related",
          depth: { max: 3 },
          edgeWhere: { weight: { gt: 1 } },
          where: { chunks: { some: { draft: false } } },
        },
      ],
    });
    expect(c.text).toContain(
      "((:`GrChunk`)-[e0:`GR_MENTIONS`]->(:`GrEntity`) WHERE (e0.`count` >= $p0)){1,1}" +
        "((:`GrEntity`)-[e1:`GR_RELATED`]->(t2:`GrEntity`) WHERE " +
        "(EXISTS { MATCH (t2)<-[:`GR_MENTIONS`]-(m3:`GrChunk`) WHERE m3.`draft` = $p1 }) AND " +
        "(e1.`weight` > $p2)){1,3}(n:`GrEntity`)",
    );
  });

  it("ends on the last hop's model: projection, ordering and paths", () => {
    const c = hops({
      from: { id: "c1" },
      via: [{ rel: "entities" }],
      orderBy: { chunks: { _count: "desc", where: { draft: false } } },
      take: 2,
      returnPaths: true,
    });
    expect(c.text).toContain("(n:`GrEntity`)");
    expect(c.text).toContain(
      "ORDER BY COUNT { MATCH (n)<-[:`GR_MENTIONS`]-(m1:`GrChunk`) WHERE m1.`draft` = $p1 } DESC LIMIT $p2",
    );
    expect(c.text).toContain("RETURN n{.`id`, .`name`, .`kind`} AS row");
  });

  it("includes the start node with zero hops only when every hop may be skipped", () => {
    const entity = graphSchema.nodes.find((n) => n.name === "GrEntity")!;
    const c = compileTraverse(
      new QueryContext(graphSchema),
      entity,
      { from: { id: "e1" }, via: [{ rel: "related", depth: { min: 0, max: 2 } }] },
      10,
    );
    expect(c.text).not.toContain("n <> s");
  });

  it("validates hops", () => {
    const bad =
      (via: unknown, extra: Record<string, unknown> = {}, max = 10) =>
      () =>
        hops({ from: {}, via, ...extra }, max);
    expect(bad([{ rel: "entities" }, { rel: "entities" }])).toThrow(
      'traverse: via[1]: unknown relation "GrEntity.entities"',
    );
    expect(bad([{ rel: "entities", depth: { max: 2 } }])).toThrow(
      "via[0]: depth repeats a hop, so its relations must lead back to GrChunk",
    );
    expect(bad([{ rel: ["entities", "doc"] }])).toThrow("must lead to one model");
    expect(bad([{ rel: "entities" }, "chunks"])).toThrow("takes objects only");
    expect(bad([{ rel: "entities", weight: 1 }])).toThrow('unknown hop option "weight"');
    expect(bad([{}])).toThrow("via[0]: rel is required");
    expect(bad([{ rel: "entities" }], { depth: { max: 2 } })).toThrow("depth goes on each hop");
    expect(bad([{ rel: "entities" }], { edgeWhere: {} })).toThrow("edgeWhere goes on each hop");
    expect(
      bad([{ rel: "entities" }, { rel: "related", depth: { max: 3 } }, { rel: "chunks" }], {}, 4),
    ).toThrow("add up to more than the maximum traversal depth of 4");
    expect(bad([{ rel: "doc", edgeWhere: { x: 1 } }])).toThrow("share one relationship");
    for (const f of [bad([{ rel: "nope" }]), bad([{ rel: "entities", direction: "up" }])]) {
      expect(f).toThrow(CyphraValidationError);
    }
  });

  it("decodes paths through several models", () => {
    const path = decodePath(graphSchema, {
      nodes: [
        { labels: ["GrChunk"], properties: { id: "c1", text: "t", draft: false } },
        { labels: ["GrEntity"], properties: { id: "e1", name: "Ada", kind: "person" } },
        { labels: ["GrEntity"], properties: { id: "e2", name: "Bab", kind: "person" } },
      ],
      edges: [
        { type: "GR_MENTIONS", properties: { count: 2 }, out: true },
        { type: "GR_RELATED", properties: { weight: 3 }, out: false },
      ],
    });
    expect(path.nodes.map((n) => n.id)).toEqual(["c1", "e1", "e2"]);
    expect(path.edges).toEqual([
      { type: "GR_MENTIONS", direction: "out", properties: { count: 2 } },
      {
        type: "GR_RELATED",
        direction: "in",
        properties: { weight: 3, score: null, note: null },
      },
    ]);
  });
});
