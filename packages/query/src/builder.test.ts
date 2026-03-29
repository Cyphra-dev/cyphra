import { describe, expect, it } from "vitest";
import { eq, node, prop, rel, select } from "./builder.js";

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
});
