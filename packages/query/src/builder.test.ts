import { describe, expect, it } from "vitest";
import {
  and,
  bareVar,
  between,
  contains,
  endsWith,
  eq,
  exists,
  gte,
  inList,
  isNotNull,
  isNull,
  matches,
  neq,
  node,
  not,
  or,
  prop,
  rel,
  select,
  startsWith,
} from "./builder.js";

describe("SelectQuery", () => {
  it("builds MATCH/WHERE/RETURN with parameters", () => {
    const u = node("User", "u");
    const o = node("Organization", "o");
    const m = rel("MEMBER_OF", "m");
    const q = select()
      .match(u.out(m, o))
      .where(eq(prop(m.alias, "role"), "admin"))
      .returnFields({ userId: prop(u.alias, "id"), orgName: prop(o.alias, "name") });
    const { text, params } = q.toCypher();
    expect(text).toBe(
      "MATCH (u:User)-[m:MEMBER_OF]->(o:Organization) WHERE m.role = $p0 RETURN u.id AS userId, o.name AS orgName",
    );
    expect(params).toEqual({ p0: "admin" });
  });

  it("supports incoming and undirected patterns", () => {
    const u = node("User", "u");
    const p = node("Post", "p");
    const a = rel("AUTHORED", "a");
    expect(u.in(a, p)).toBe("(u:User)<-[a:AUTHORED]-(p:Post)");
    expect(u.both(a, p)).toBe("(u:User)-[a:AUTHORED]-(p:Post)");
  });

  it("rejects invalid node()/rel() identifiers", () => {
    expect(() => node("User-Profile", "u")).toThrow(/invalid identifier/);
    expect(() => node("User", "u-1")).toThrow(/invalid identifier/);
    expect(() => rel("MEMBER-OF", "m")).toThrow(/invalid identifier/);
    expect(() => rel("MEMBER_OF", "m-1")).toThrow(/invalid identifier/);
  });

  it("supports variable-length rel() quantifiers", () => {
    const a = node("Person", "a");
    const b = node("Person", "b");
    expect(a.out(rel("KNOWS", "r", "any"), b)).toBe("(a:Person)-[r:KNOWS*]->(b:Person)");
    expect(a.out(rel("KNOWS", "r", 2), b)).toBe("(a:Person)-[r:KNOWS*2]->(b:Person)");
    expect(a.out(rel("KNOWS", "r", { min: 1, max: 3 }), b)).toBe(
      "(a:Person)-[r:KNOWS*1..3]->(b:Person)",
    );
    expect(a.out(rel("KNOWS", "r", { max: 5 }), b)).toBe("(a:Person)-[r:KNOWS*..5]->(b:Person)");
    expect(a.out(rel("KNOWS", "r", { min: 2 }), b)).toBe("(a:Person)-[r:KNOWS*2..]->(b:Person)");
  });

  it("rejects prop() with empty property name", () => {
    expect(() => prop("u", "")).toThrow(/bareVar/);
  });

  it("RETURN and ORDER BY support bareVar projection", () => {
    const { text } = select()
      .match("(n:N)")
      .returnFields({ node: bareVar("n") })
      .orderBy({ prop: bareVar("n"), direction: "ASC" })
      .toCypher();
    expect(text).toContain("RETURN n AS node");
    expect(text).toContain("ORDER BY n ASC");
  });

  it("rejects invalid rel() varLength", () => {
    expect(() => rel("R", "r", -1)).toThrow(/non-negative integer/);
    expect(() => rel("R", "r", 1.5)).toThrow(/non-negative integer/);
    expect(() => rel("R", "r", {} as { min?: number; max?: number })).toThrow(/requires min/);
    expect(() => rel("R", "r", { min: 3, max: 1 })).toThrow(/min must be <= max/);
  });

  it("appends OPTIONAL MATCH after MATCH", () => {
    const u = node("User", "u");
    const f = node("User", "f");
    const r = rel("FOLLOWS", "r");
    const { text } = select()
      .match(`(${u.alias}:${u.label})`)
      .optionalMatch(u.out(r, f))
      .returnStar()
      .toCypher();
    expect(text).toBe("MATCH (u:User) OPTIONAL MATCH (u:User)-[r:FOLLOWS]->(f:User) RETURN *");
  });

  it("allows multiple optionalMatch calls", () => {
    const { text } = select()
      .match("(a:A)")
      .optionalMatch("(a)-[:R1]->(b:B)")
      .optionalMatch("(a)-[:R2]->(c:C)")
      .returnStar()
      .toCypher();
    expect(text).toBe(
      "MATCH (a:A) OPTIONAL MATCH (a)-[:R1]->(b:B) OPTIONAL MATCH (a)-[:R2]->(c:C) RETURN *",
    );
  });

  it("rejects optionalMatch before match", () => {
    expect(() => select().optionalMatch("(x:X)")).toThrow(/match\(\) before optionalMatch/);
  });

  it("adds ORDER BY, SKIP, and LIMIT with parameters", () => {
    const u = node("User", "u");
    const q = select()
      .match(`(${u.alias}:${u.label})`)
      .returnFields({ id: prop(u.alias, "id") })
      .orderBy({ prop: prop(u.alias, "createdAt"), direction: "DESC" })
      .skip(10)
      .limit(5);
    const { text, params } = q.toCypher();
    expect(text).toBe(
      "MATCH (u:User) RETURN u.id AS id ORDER BY u.createdAt DESC SKIP toInteger($p0) LIMIT toInteger($p1)",
    );
    expect(params).toEqual({ p0: 10, p1: 5 });
  });

  it("ORDER BY supports NULLS FIRST / NULLS LAST", () => {
    const u = node("User", "u");
    const { text } = select()
      .match(`(${u.alias}:${u.label})`)
      .returnFields({ id: prop(u.alias, "id") })
      .orderBy(
        { prop: prop(u.alias, "nickname"), direction: "ASC", nulls: "LAST" },
        { prop: prop(u.alias, "score"), direction: "DESC", nulls: "FIRST" },
      )
      .toCypher();
    expect(text).toContain("ORDER BY u.nickname ASC NULLS LAST, u.score DESC NULLS FIRST");
  });

  it("withOrderLimit passes nulls through ORDER BY", () => {
    const { text, params } = select()
      .match("(p:Post)")
      .withOrderLimit(
        ["p"],
        [{ prop: prop("p", "publishedAt"), direction: "DESC", nulls: "LAST" }],
        10,
      )
      .where(eq(prop("p", "slug"), "x"))
      .returnStar()
      .toCypher();
    expect(text).toContain("WITH p ORDER BY p.publishedAt DESC NULLS LAST LIMIT toInteger($p0)");
    expect(params.p0).toBe(10);
  });

  it("rejects invalid skip/limit", () => {
    expect(() => select().match("(u:U)").skip(-1).toCypher()).toThrow(/skip/);
    expect(() => select().match("(u:U)").limit(1.5).toCypher()).toThrow(/limit/);
  });

  it("combines comparisons, null checks, IN, and string predicates with parameters", () => {
    const u = node("User", "u");
    const q = select()
      .match(`(${u.alias}:${u.label})`)
      .where(
        neq(prop(u.alias, "status"), "banned"),
        isNull(prop(u.alias, "deletedAt")),
        isNotNull(prop(u.alias, "email")),
        gte(prop(u.alias, "score"), 10),
        inList(prop(u.alias, "role"), ["admin", "mod"]),
        startsWith(prop(u.alias, "email"), "evil"),
        endsWith(prop(u.alias, "email"), ".com"),
        contains(prop(u.alias, "name"), `'"`), // stays a param, not Cypher injection
        matches(prop(u.alias, "email"), "^[a-z]+@"),
      )
      .returnFields({ id: prop(u.alias, "id") });
    const { text, params } = q.toCypher();
    expect(text).toBe(
      [
        "MATCH (u:User) WHERE u.status <> $p0 AND u.deletedAt IS NULL AND u.email IS NOT NULL",
        "AND u.score >= $p1 AND u.role IN $p2 AND u.email STARTS WITH $p3 AND u.email ENDS WITH $p4",
        "AND u.name CONTAINS $p5 AND u.email =~ $p6 RETURN u.id AS id",
      ].join(" "),
    );
    expect(params).toEqual({
      p0: "banned",
      p1: 10,
      p2: ["admin", "mod"],
      p3: "evil",
      p4: ".com",
      p5: `'"`,
      p6: "^[a-z]+@",
    });
  });

  it("rejects empty inList", () => {
    const u = node("User", "u");
    expect(() => inList(prop(u.alias, "x"), [])).toThrow(/empty list/);
  });

  it("wraps predicates with NOT (...)", () => {
    const u = node("User", "u");
    const q = select()
      .match(`(${u.alias}:${u.label})`)
      .where(not(eq(prop(u.alias, "role"), "admin")))
      .returnStar();
    const { text, params } = q.toCypher();
    expect(text).toBe("MATCH (u:User) WHERE NOT (u.role = $p0) RETURN *");
    expect(params).toEqual({ p0: "admin" });
  });

  it("requires returnFields, returnRawFields, or returnStar", () => {
    const u = node("User", "u");
    expect(() => select().match(`(${u.alias}:${u.label})`).toCypher()).toThrow(/returnFields/);
  });

  it("returnRawFields supports aggregates and ORDER BY on expression", () => {
    const { text, params } = select()
      .match("(n:N)")
      .returnRawFields({ role: "n.role", total: "count(*)" })
      .orderBy({ expression: "total", direction: "DESC" })
      .toCypher();
    expect(text).toBe("MATCH (n:N) RETURN n.role AS role, count(*) AS total ORDER BY total DESC");
    expect(params).toEqual({});
  });

  it("rejects invalid output aliases for returnFields", () => {
    expect(() =>
      select()
        .match("(n:N)")
        .returnFields({ "bad-alias": prop("n", "id") }),
    ).toThrow(/invalid identifier/);
  });

  it("ORDER BY expression supports NULLS", () => {
    const { text } = select()
      .match("(n:N)")
      .returnRawFields({ c: "count(n)" })
      .orderBy({ expression: "c", direction: "ASC", nulls: "LAST" })
      .toCypher();
    expect(text).toContain("ORDER BY c ASC NULLS LAST");
  });

  it("rejects empty returnRawFields", () => {
    expect(() => select().match("(n:N)").returnRawFields({})).toThrow(/at least one field/);
    expect(() => select().match("(n:N)").returnRawFields({ a: "  " })).toThrow(/empty expression/);
  });

  it("use() prefixes USE clause", () => {
    const { text } = select().use("g.sub").match("(n:N)").returnStar().toCypher();
    expect(text).toBe("USE g.sub MATCH (n:N) RETURN *");
  });

  it("rejects invalid use() names", () => {
    expect(() => select().use("")).toThrow(/non-empty/);
    expect(() => select().use("bad-")).toThrow(/invalid qualified/);
  });

  it("supports RETURN *", () => {
    const u = node("User", "u");
    const { text } = select().match(`(${u.alias}:${u.label})`).returnStar().toCypher();
    expect(text).toBe("MATCH (u:User) RETURN *");
  });

  it("supports RETURN DISTINCT *", () => {
    const u = node("User", "u");
    const { text } = select()
      .match(`(${u.alias}:${u.label})`)
      .returnStar()
      .returnDistinct()
      .toCypher();
    expect(text).toBe("MATCH (u:User) RETURN DISTINCT *");
  });

  it("supports RETURN DISTINCT with projected fields", () => {
    const u = node("User", "u");
    const { text } = select()
      .match(`(${u.alias}:${u.label})`)
      .returnFields({ id: prop(u.alias, "id") })
      .returnDistinct()
      .toCypher();
    expect(text).toBe("MATCH (u:User) RETURN DISTINCT u.id AS id");
  });

  it("allows returnDistinct before returnStar", () => {
    const u = node("User", "u");
    const { text } = select()
      .match(`(${u.alias}:${u.label})`)
      .returnDistinct()
      .returnStar()
      .toCypher();
    expect(text).toBe("MATCH (u:User) RETURN DISTINCT *");
  });

  it("builds inclusive between with two parameters", () => {
    const u = node("User", "u");
    const q = select()
      .match(`(${u.alias}:${u.label})`)
      .where(between(prop(u.alias, "score"), 0, 100))
      .returnStar();
    const { text, params } = q.toCypher();
    expect(text).toBe("MATCH (u:User) WHERE (u.score >= $p0 AND u.score <= $p1) RETURN *");
    expect(params).toEqual({ p0: 0, p1: 100 });
  });

  it("groups OR and AND with correct Cypher precedence", () => {
    const u = node("User", "u");
    const q = select()
      .match(`(${u.alias}:${u.label})`)
      .where(
        or(eq(prop(u.alias, "role"), "admin"), eq(prop(u.alias, "role"), "mod")),
        eq(prop(u.alias, "active"), true),
      )
      .returnStar();
    const { text, params } = q.toCypher();
    expect(text).toBe(
      "MATCH (u:User) WHERE (u.role = $p0 OR u.role = $p1) AND u.active = $p2 RETURN *",
    );
    expect(params).toEqual({ p0: "admin", p1: "mod", p2: true });
  });

  it("parenthesizes AND under OR", () => {
    const u = node("User", "u");
    const q = select()
      .match(`(${u.alias}:${u.label})`)
      .where(
        or(and(eq(prop(u.alias, "a"), 1), eq(prop(u.alias, "b"), 2)), eq(prop(u.alias, "c"), 3)),
      )
      .returnStar();
    const { text, params } = q.toCypher();
    expect(text).toBe("MATCH (u:User) WHERE (u.a = $p0 AND u.b = $p1) OR u.c = $p2 RETURN *");
    expect(params).toEqual({ p0: 1, p1: 2, p2: 3 });
  });

  it("parenthesizes OR under AND", () => {
    const u = node("User", "u");
    const q = select()
      .match(`(${u.alias}:${u.label})`)
      .where(
        and(or(eq(prop(u.alias, "x"), 1), eq(prop(u.alias, "x"), 2)), eq(prop(u.alias, "y"), 3)),
      )
      .returnStar();
    const { text, params } = q.toCypher();
    expect(text).toBe("MATCH (u:User) WHERE (u.x = $p0 OR u.x = $p1) AND u.y = $p2 RETURN *");
    expect(params).toEqual({ p0: 1, p1: 2, p2: 3 });
  });

  it("rejects empty and() / or()", () => {
    expect(() => and()).toThrow(/and\(\)/);
    expect(() => or()).toThrow(/or\(\)/);
  });

  it("EXISTS subquery predicate", () => {
    const u = node("User", "u");
    const q = select()
      .match(`(${u.alias}:${u.label})`)
      .where(
        exists(`(${u.alias}:${u.label})-[:POSTED]->(p:Post)`, eq(prop("p", "published"), true)),
      )
      .returnStar();
    const { text, params } = q.toCypher();
    expect(text).toBe(
      "MATCH (u:User) WHERE EXISTS { MATCH (u:User)-[:POSTED]->(p:Post) WHERE p.published = $p0 } RETURN *",
    );
    expect(params).toEqual({ p0: true });
  });

  it("EXISTS without inner WHERE", () => {
    const { text, params } = select()
      .match("(o:Order)")
      .where(exists("(o)-[:CONTAINS]->(:LineItem)"))
      .returnStar()
      .toCypher();
    expect(text).toBe(
      "MATCH (o:Order) WHERE EXISTS { MATCH (o)-[:CONTAINS]->(:LineItem) } RETURN *",
    );
    expect(params).toEqual({});
  });

  it("rejects empty exists() pattern", () => {
    expect(() => exists("  ", eq(prop("n", "x"), 1))).toThrow(/matchPattern/);
  });

  it("WITH ORDER BY LIMIT before WHERE", () => {
    const q = select()
      .match("(p:Post)")
      .withOrderLimit(["p"], [{ prop: prop("p", "createdAt"), direction: "DESC" }], 20)
      .where(eq(prop("p", "slug"), "hello"))
      .returnStar();
    const { text, params } = q.toCypher();
    expect(text).toBe(
      "MATCH (p:Post) WITH p ORDER BY p.createdAt DESC LIMIT toInteger($p0) WHERE p.slug = $p1 RETURN *",
    );
    expect(params).toEqual({ p0: 20, p1: "hello" });
  });

  it("WITH DISTINCT before WHERE", () => {
    const { text, params } = select()
      .match("(n:N)")
      .withDistinct(["n"])
      .where(eq(prop("n", "k"), 1))
      .returnStar()
      .toCypher();
    expect(text).toBe("MATCH (n:N) WITH DISTINCT n WHERE n.k = $p0 RETURN *");
    expect(params).toEqual({ p0: 1 });
  });

  it("WITH DISTINCT ORDER BY LIMIT before WHERE", () => {
    const { text, params } = select()
      .match("(u:User)")
      .withOrderLimit(["u"], [{ prop: prop("u", "score"), direction: "DESC" }], 5, {
        distinct: true,
      })
      .where(eq(prop("u", "active"), true))
      .returnStar()
      .toCypher();
    expect(text).toBe(
      "MATCH (u:User) WITH DISTINCT u ORDER BY u.score DESC LIMIT toInteger($p0) WHERE u.active = $p1 RETURN *",
    );
    expect(params).toEqual({ p0: 5, p1: true });
  });
});
