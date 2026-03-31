import { describe, expect, it } from "vitest";
import { eq, prop } from "./builder.js";
import {
  compileCreate,
  compileCreateRelationship,
  compileCreateRelationshipIn,
  compileDeleteRelationshipWhere,
  compileDeleteWhere,
  compileDetachDeleteWhere,
  compileForeachDeleteRelationshipsFromPath,
  compileForeachMergeSet,
  compileMergeRelationship,
  compileMergeRelationshipIn,
  compileMergeSet,
  compileRemoveProperties,
  compileRemoveRelationshipProperties,
  compileSetRelationshipWhere,
  compileSetWhere,
  compileUnwindDetachDelete,
  compileUnwindMergeSet,
} from "./write.js";

describe("write helpers", () => {
  it("compileCreate", () => {
    const c = compileCreate("Post", { title: "Hi" });
    expect(c.text).toContain("CREATE (n:Post)");
    expect(c.params.props).toEqual({ title: "Hi" });
  });

  it("compileCreate rejects invalid label/alias identifiers", () => {
    expect(() => compileCreate("Bad-Label", {})).toThrow(/invalid identifier/);
    expect(() => compileCreate("Post", {}, "bad-alias")).toThrow(/invalid identifier/);
  });

  it("compileMergeSet", () => {
    const c = compileMergeSet("Post", "slug", "a-slug", { title: "T" });
    expect(c.text).toContain("MERGE (n:Post { slug: $keyVal })");
  });

  it("compileMergeSet ON CREATE / ON MATCH", () => {
    const c = compileMergeSet(
      "Person",
      "id",
      "u1",
      {},
      { onCreate: { name: "N" }, onMatch: { seen: true } },
    );
    expect(c.text).toBe(
      "MERGE (n:Person { id: $keyVal }) ON CREATE SET n += $onCreateProps ON MATCH SET n += $onMatchProps",
    );
    expect(c.params).toEqual({
      keyVal: "u1",
      onCreateProps: { name: "N" },
      onMatchProps: { seen: true },
    });
  });

  it("compileMergeSet modifiers plus trailing SET when props non-empty", () => {
    const c = compileMergeSet("Person", "id", 1, { version: 2 }, { onCreate: { created: true } });
    expect(c.text).toBe(
      "MERGE (n:Person { id: $keyVal }) ON CREATE SET n += $onCreateProps SET n += $props",
    );
    expect(c.params.keyVal).toBe(1);
    expect(c.params.onCreateProps).toEqual({ created: true });
    expect(c.params.props).toEqual({ version: 2 });
  });

  it("compileMergeRelationship with props", () => {
    const c = compileMergeRelationship("a", "r", "KNOWS", "b", { since: 2020 });
    expect(c.text).toBe("MERGE (a)-[r:KNOWS]->(b) SET r += $props");
    expect(c.params.props).toEqual({ since: 2020 });
  });

  it("compileMergeRelationship omits SET when props empty", () => {
    const c = compileMergeRelationship("u", "m", "MEMBER_OF", "o");
    expect(c.text).toBe("MERGE (u)-[m:MEMBER_OF]->(o)");
    expect(c.params).toEqual({});
  });

  it("compileCreateRelationship", () => {
    const c = compileCreateRelationship("a", "r", "R", "b", { x: 1 });
    expect(c.text).toBe("CREATE (a)-[r:R]->(b) SET r += $props");
  });

  it("compileCreateRelationshipIn and compileMergeRelationshipIn", () => {
    expect(compileCreateRelationshipIn("child", "r", "OF", "parent", {}).text).toBe(
      "CREATE (child)<-[r:OF]-(parent)",
    );
    expect(compileMergeRelationshipIn("b", "m", "LINK", "a", { k: 1 }).text).toBe(
      "MERGE (b)<-[m:LINK]-(a) SET m += $props",
    );
  });

  it("compileDetachDeleteWhere", () => {
    const c = compileDetachDeleteWhere("Post", "p", [eq(prop("p", "slug"), "x")]);
    expect(c.text).toMatch(/MATCH \(p:Post\) WHERE .* DETACH DELETE p/);
  });

  it("node write helpers reject invalid label/alias identifiers", () => {
    expect(() => compileDetachDeleteWhere("Bad-Post", "p", [eq(prop("p", "slug"), "x")])).toThrow(
      /invalid identifier/,
    );
    expect(() => compileSetWhere("Post", "bad-alias", [eq(prop("p", "slug"), "x")], {})).toThrow(
      /invalid identifier/,
    );
    expect(() => compileDeleteWhere("Post", "bad-alias", [eq(prop("p", "slug"), "x")])).toThrow(
      /invalid identifier/,
    );
    expect(() =>
      compileRemoveProperties("Post", "bad-alias", [eq(prop("p", "slug"), "x")], ["legacy"]),
    ).toThrow(/invalid identifier/);
  });

  it("compileSetWhere", () => {
    const c = compileSetWhere("Post", "p", [eq(prop("p", "slug"), "x")], { title: "New" });
    expect(c.text).toContain("SET p += $props");
  });

  it("compileDeleteWhere", () => {
    const c = compileDeleteWhere("Post", "p", [eq(prop("p", "slug"), "x")]);
    expect(c.text).toMatch(/MATCH \(p:Post\) WHERE .* DELETE p$/);
  });

  it("compileDeleteRelationshipWhere default out", () => {
    const c = compileDeleteRelationshipWhere("FOLLOWS", "r", [eq(prop("r", "since"), 2020)]);
    expect(c.text).toBe("MATCH ()-[r:FOLLOWS]->() WHERE r.since = $p0 DELETE r");
    expect(c.params).toEqual({ p0: 2020 });
  });

  it("compileDeleteRelationshipWhere in and undirected", () => {
    expect(
      compileDeleteRelationshipWhere("R", "r", [eq(prop("r", "x"), 1)], { ends: "in" }).text,
    ).toBe("MATCH ()<-[r:R]-() WHERE r.x = $p0 DELETE r");
    expect(
      compileDeleteRelationshipWhere("R", "r", [eq(prop("r", "x"), 1)], { ends: "undirected" })
        .text,
    ).toBe("MATCH ()-[r:R]-() WHERE r.x = $p0 DELETE r");
  });

  it("compileSetRelationshipWhere", () => {
    const c = compileSetRelationshipWhere("R", "r", [eq(prop("r", "id"), "x")], { weight: 1 });
    expect(c.text).toBe("MATCH ()-[r:R]->() WHERE r.id = $p0 SET r += $props");
    expect(c.params).toEqual({ p0: "x", props: { weight: 1 } });
  });

  it("compileRemoveRelationshipProperties", () => {
    const c = compileRemoveRelationshipProperties("R", "r", [eq(prop("r", "id"), "y")], ["legacy"]);
    expect(c.text).toBe("MATCH ()-[r:R]->() WHERE r.id = $p0 REMOVE r.legacy");
  });

  it("compileRemoveProperties", () => {
    const c = compileRemoveProperties("Post", "p", [eq(prop("p", "slug"), "x")], ["legacy"]);
    expect(c.text).toContain("REMOVE p.legacy");
  });

  it("compileUnwindMergeSet", () => {
    const rows = [{ id: "1", patch: { title: "A" } }];
    const c = compileUnwindMergeSet("Post", "id", rows);
    expect(c.text).toContain("UNWIND $rows AS row");
    expect(c.text).toContain("MERGE (n:Post { id: row.id })");
    expect(c.params.rows).toBe(rows);
  });

  it("compileUnwindDetachDelete", () => {
    const c = compileUnwindDetachDelete("Post", "slug", ["a", "b"]);
    expect(c.text).toBe("UNWIND $ids AS id MATCH (n:Post) WHERE n.slug = id DETACH DELETE n");
    expect(c.params.ids).toEqual(["a", "b"]);
  });

  it("compileForeachMergeSet", () => {
    const rows = [{ id: "1", patch: { title: "A" } }];
    const c = compileForeachMergeSet("Post", "id", rows);
    expect(c.text).toBe(
      "FOREACH (row IN $rows | MERGE (n:Post { id: row.id }) SET n += coalesce(row.patch, {}))",
    );
    expect(c.params.rows).toBe(rows);
  });

  it("compileForeachDeleteRelationshipsFromPath", () => {
    const c = compileForeachDeleteRelationshipsFromPath("p", "rel");
    expect(c.text).toBe("FOREACH (rel IN relationships(p) | DELETE rel)");
    expect(c.params).toEqual({});
  });
});
