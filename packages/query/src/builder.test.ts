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
});
