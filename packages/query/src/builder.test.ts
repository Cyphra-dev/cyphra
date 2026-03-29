import { describe, expect, it } from "vitest";
import {
  contains,
  endsWith,
  eq,
  gte,
  inList,
  isNotNull,
  isNull,
  neq,
  node,
  not,
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
      )
      .returnFields({ id: prop(u.alias, "id") });
    const { text, params } = q.toCypher();
    expect(text).toBe(
      [
        "MATCH (u:User) WHERE u.status <> $p0 AND u.deletedAt IS NULL AND u.email IS NOT NULL",
        "AND u.score >= $p1 AND u.role IN $p2 AND u.email STARTS WITH $p3 AND u.email ENDS WITH $p4",
        "AND u.name CONTAINS $p5 RETURN u.id AS id",
      ].join(" "),
    );
    expect(params).toEqual({
      p0: "banned",
      p1: 10,
      p2: ["admin", "mod"],
      p3: "evil",
      p4: ".com",
      p5: `'"`,
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
});
