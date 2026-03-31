import { describe, expect, it } from "vitest";
import { compileCollectBlock, compileCountBlock, compileExistsBlock } from "./subqueryExpression.js";

describe("subqueryExpression", () => {
  it("compileExistsBlock remaps parameters", () => {
    expect(
      compileExistsBlock({
        text: "MATCH (m:Person) WHERE m.id = $p0 RETURN m",
        params: { p0: "x" },
      }),
    ).toEqual({
      text: "EXISTS { MATCH (m:Person) WHERE m.id = $ex_p0 RETURN m }",
      params: { ex_p0: "x" },
    });
  });

  it("compileCountBlock and compileCollectBlock", () => {
    expect(
      compileCountBlock({ text: "MATCH (n:N) RETURN n", params: {} }),
    ).toEqual({
      text: "COUNT { MATCH (n:N) RETURN n }",
      params: {},
    });
    expect(
      compileCollectBlock({ text: "MATCH (n:N) RETURN n AS x", params: {} }),
    ).toEqual({
      text: "COLLECT { MATCH (n:N) RETURN n AS x }",
      params: {},
    });
  });
});
