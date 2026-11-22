import { describe, expect, it } from "vitest";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { schemaModel } from "./__fixtures__/blog.gen.js";
import { QueryContext } from "./compile.js";
import { CyphraValidationError } from "./errors.js";
import { compileShortestPath } from "./shortest.js";

const user = schemaModel.nodes.find((n) => n.name === "User")!;
const post = schemaModel.nodes.find((n) => n.name === "Post")!;

function shortest(args: Record<string, unknown>, all = false, max = 10) {
  return compileShortestPath(new QueryContext(schemaModel), user, args, max, all);
}

const base = { from: { id: "a" }, to: { id: "b" }, via: "following", maxDepth: 4 };

describe("compileShortestPath", () => {
  it("compiles SHORTEST 1 between the matched start and end nodes", () => {
    const c = shortest(base);
    expect(c.text).toBe(
      "MATCH (s:`User`) WHERE s.`id` = $p0 MATCH (t:`User`) WHERE t.`id` = $p1 " +
        "MATCH p = SHORTEST 1 (s)((:`User`)-[e0:`FOLLOWS`]->(:`User`)){0,4}(t) " +
        "WITH p ORDER BY length(p) LIMIT 1 " +
        "RETURN [n1 IN nodes(p) | n1{.`id`, .`email`, .`name`, .`age`, .`tags`, .`createdAt`}] AS nodes, " +
        // The path's nodes carry only their labels (to type the edges): `nodes` has their fields.
        "{nodes: [x2 IN nodes(p) | {labels: labels(x2)}], " +
        "edges: [i3 IN range(0, length(p) - 1) | {type: type(relationships(p)[i3]), " +
        "properties: properties(relationships(p)[i3]), out: startNode(relationships(p)[i3]) = nodes(p)[i3]}]} AS path",
    );
    expect(c.params).toEqual({ p0: "a", p1: "b" });
  });

  it("keeps every path of the minimum length with ALL SHORTEST, capped by take", () => {
    const c = shortest({ ...base, take: 3 }, true);
    expect(c.text).toContain("MATCH p = ALL SHORTEST (s)(");
    expect(c.text).toContain(
      "){0,4}(t) WITH collect(p) AS ps, min(length(p)) AS d " +
        "UNWIND [x1 IN ps WHERE length(x1) = d] AS p WITH p LIMIT $p2 RETURN",
    );
    expect((c.params.p2 as { toNumber(): number }).toNumber()).toBe(3);
    expect(shortest(base, true).text).not.toContain("LIMIT");
  });

  it("filters edges in the hop and intermediate nodes in the path pattern", () => {
    const since = new Date("2024-01-01T00:00:00Z");
    const c = shortest({
      ...base,
      direction: "both",
      where: { age: { gte: 18 } },
      edgeWhere: { since: { gte: since } },
    });
    expect(c.text).toContain(
      "MATCH p = SHORTEST 1 ((s)((:`User`)-[e1:`FOLLOWS`]-(y0:`User`) WHERE (e1.`since` >= $p2)){0,4}(t) " +
        "WHERE all(x2 IN y0[..-1] WHERE x2.`age` >= $p3)) WITH p",
    );
    expect(String(c.params.p2)).toBe("2024-01-01T00:00:00Z");
  });

  it("filters intermediate nodes with mixed directions", () => {
    const schema = resolveSchema(
      parseSchema(`
        node Person {
          id      String   @id
          level   Int
          manages Person[] @relationship(type: "MANAGES", direction: OUT)
          mentors Person[] @relationship(type: "MENTORS", direction: IN)
        }
      `),
    );
    const c = compileShortestPath(
      new QueryContext(schema),
      schema.nodes[0]!,
      {
        from: { id: "a" },
        to: { id: "b" },
        via: ["manages", "mentors"],
        maxDepth: 3,
        where: { level: { lt: 3 } },
      },
      10,
      false,
    );
    expect(c.text).toContain(
      "((s)((x2:`Person`)-[e1:`MANAGES`|`MENTORS`]-(y0:`Person`) " +
        "WHERE ((type(e1) = $p2 AND startNode(e1) = x2) OR (type(e1) = $p3 AND endNode(e1) = x2))){0,3}(t) " +
        "WHERE all(x3 IN y0[..-1] WHERE x3.`level` < $p4))",
    );
  });

  it("projects path nodes with select / include", () => {
    const c = shortest({ ...base, select: { email: true, _count: { select: { posts: true } } } });
    expect(c.text).toContain(
      "RETURN [n1 IN nodes(p) | n1{.`email`, `_count`: {`posts`: COUNT { MATCH (n1)-[:`AUTHORED`]->(m2:`Post`) }}}] AS nodes",
    );
    const rows = c.decode([
      {
        nodes: [
          { email: "a@x.io", _count: { posts: 2 } },
          { email: "b@x.io", _count: { posts: 0 } },
        ],
        path: {
          nodes: [
            { labels: ["User"], properties: { email: "a@x.io" } },
            { labels: ["User"], properties: { email: "b@x.io" } },
          ],
          edges: [{ type: "FOLLOWS", properties: {}, out: true }],
        },
      },
    ]);
    expect(rows).toEqual([
      {
        nodes: [
          { email: "a@x.io", _count: { posts: 2 } },
          { email: "b@x.io", _count: { posts: 0 } },
        ],
        edges: [{ type: "FOLLOWS", direction: "out", properties: { since: null } }],
      },
    ]);
  });

  it("rejects missing ends, missing or excessive maxDepth and bad options", () => {
    const bad = (args: Record<string, unknown>, all = false, max?: number) =>
      expect(() => shortest(args, all, max)).toThrow(CyphraValidationError);
    bad({ ...base, from: undefined });
    bad({ ...base, to: undefined });
    bad({ ...base, to: "b" });
    bad({ ...base, maxDepth: undefined });
    bad({ ...base, maxDepth: 0 });
    bad({ ...base, maxDepth: 2.5 });
    bad({ ...base, maxDepth: "3" });
    bad({ ...base, maxDepth: 11 });
    bad({ ...base, maxDepth: 4 }, false, 3);
    bad({ ...base, via: "friends" });
    bad({ ...base, via: "posts" });
    bad({ ...base, via: [] });
    bad({ ...base, direction: "up" });
    bad({ ...base, edgeWhere: { weight: 1 } });
    bad({ ...base, where: { nope: 1 } });
    bad({ ...base, take: 2 }); // only allShortestPaths pages
    bad({ ...base, take: -1 }, true);
    bad({ ...base, depth: { max: 2 } });
    bad({ ...base, select: { email: true }, include: { posts: true } });
    expect(() => shortest({ ...base, maxDepth: 11 })).toThrow(/maxTraversalDepth/);
    expect(() => shortest({ ...base, maxDepth: undefined }, true)).toThrow(
      /allShortestPaths on User: maxDepth is required/,
    );
    expect(() =>
      compileShortestPath(
        new QueryContext(schemaModel),
        post,
        { from: {}, to: {}, via: "author", maxDepth: 1 },
        10,
        false,
      ),
    ).toThrow(/shortestPath: Post.author leads to User/);
  });
});
