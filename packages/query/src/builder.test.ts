import { describe, expect, it } from "vitest";
import {
  and,
  between,
  contains,
  endsWith,
  eq,
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
      "MATCH (u:User) RETURN u.id AS id ORDER BY u.createdAt DESC SKIP $p0 LIMIT $p1",
    );
    expect(params).toEqual({ p0: 10, p1: 5 });
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

  it("requires returnFields or returnStar", () => {
    const u = node("User", "u");
    expect(() => select().match(`(${u.alias}:${u.label})`).toCypher()).toThrow(/returnFields/);
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
      .where(or(and(eq(prop(u.alias, "a"), 1), eq(prop(u.alias, "b"), 2)), eq(prop(u.alias, "c"), 3)))
      .returnStar();
    const { text, params } = q.toCypher();
    expect(text).toBe(
      "MATCH (u:User) WHERE (u.a = $p0 AND u.b = $p1) OR u.c = $p2 RETURN *",
    );
    expect(params).toEqual({ p0: 1, p1: 2, p2: 3 });
  });

  it("parenthesizes OR under AND", () => {
    const u = node("User", "u");
    const q = select()
      .match(`(${u.alias}:${u.label})`)
      .where(and(or(eq(prop(u.alias, "x"), 1), eq(prop(u.alias, "x"), 2)), eq(prop(u.alias, "y"), 3)))
      .returnStar();
    const { text, params } = q.toCypher();
    expect(text).toBe(
      "MATCH (u:User) WHERE (u.x = $p0 OR u.x = $p1) AND u.y = $p2 RETURN *",
    );
    expect(params).toEqual({ p0: 1, p1: 2, p2: 3 });
  });

  it("rejects empty and() / or()", () => {
    expect(() => and()).toThrow(/and\(\)/);
    expect(() => or()).toThrow(/or\(\)/);
  });
});
