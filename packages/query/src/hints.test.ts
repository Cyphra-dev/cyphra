import { describe, expect, it } from "vitest";
import {
  matchHintUsingIndex,
  matchHintUsingJoin,
  matchHintUsingPointIndex,
  matchHintUsingRangeIndex,
  matchHintUsingScan,
  matchHintUsingTextIndex,
} from "./hints.js";

describe("match hints", () => {
  it("matchHintUsingIndex", () => {
    expect(matchHintUsingIndex("n", "Person", ["email"])).toBe("USING INDEX n:Person(email)");
    expect(matchHintUsingIndex("r", "KNOWS", ["since"])).toBe("USING INDEX r:KNOWS(since)");
    expect(matchHintUsingIndex("n", "Person", ["lastName", "firstName"])).toBe(
      "USING INDEX n:Person(lastName, firstName)",
    );
  });

  it("matchHintUsingScan", () => {
    expect(matchHintUsingScan("n", "Person")).toBe("USING SCAN n:Person");
  });

  it("matchHintUsingRangeIndex, TextIndex, PointIndex", () => {
    expect(matchHintUsingRangeIndex("p", "Pioneer", ["born"])).toBe("USING RANGE INDEX p:Pioneer(born)");
    expect(matchHintUsingTextIndex("c", "Country", ["name"])).toBe("USING TEXT INDEX c:Country(name)");
    expect(matchHintUsingPointIndex("l", "Location", ["coord"])).toBe("USING POINT INDEX l:Location(coord)");
  });

  it("matchHintUsingJoin", () => {
    expect(matchHintUsingJoin(["a", "b"])).toBe("USING JOIN ON a, b");
  });

  it("rejects invalid identifiers", () => {
    expect(() => matchHintUsingIndex("1n", "Person", ["x"])).toThrow(/variable/);
    expect(() => matchHintUsingIndex("n", "Bad-Label", ["x"])).toThrow(/labelOrRelType/);
    expect(() => matchHintUsingIndex("n", "Person", [])).toThrow(/at least one property/);
    expect(() => matchHintUsingIndex("n", "Person", ["ok", "bad.prop"])).toThrow(/properties/);
    expect(() => matchHintUsingJoin([])).toThrow(/at least one variable/);
  });
});
