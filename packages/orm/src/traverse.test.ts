import { describe, expect, it } from "vitest";
import { compileRelatedNodes, compileShortestPath } from "./traverse.js";

describe("compileShortestPath", () => {
  it("BOTH uses undirected rel segment", () => {
    const c = compileShortestPath("User", "id", "a", "User", "id", "b", "KNOWS", 4, "BOTH");
    expect(c.text).toContain(
      "shortestPath((a:User { id: $fromId })-[r:KNOWS*1..4]-(b:User { id: $toId }))",
    );
    expect(c.params).toEqual({ fromId: "a", toId: "b" });
  });

  it("OUT direction", () => {
    const c = compileShortestPath("A", "id", 1, "B", "id", 2, "R", 3, "OUT");
    expect(c.text).toContain("-[r:R*1..3]->");
  });
});

describe("compileRelatedNodes", () => {
  it("OUT multi-hop pattern", () => {
    const c = compileRelatedNodes("User", "id", "u1", "KNOWS", "User", 2, "OUT");
    expect(c.text).toBe(
      "MATCH (a:User { id: $anchorId })-[r:KNOWS*1..2]->(b:User) RETURN DISTINCT b",
    );
    expect(c.params).toEqual({ anchorId: "u1" });
  });

  it("BOTH direction", () => {
    const c = compileRelatedNodes("Post", "slug", "x", "LINKS", "Tag", 1, "BOTH");
    expect(c.text).toContain("-[r:LINKS*1..1]-");
  });

  it("rejects invalid maxHops", () => {
    expect(() => compileRelatedNodes("A", "id", 1, "R", "B", 0)).toThrow(/maxHops/);
  });
});
