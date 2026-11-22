import { describe, expect, it } from "vitest";
import { decodeValue, literal, paramsHeader } from "./codec.js";
import {
  CypherDate,
  CypherDateTime,
  CypherDuration,
  CypherInteger,
  CypherLocalDateTime,
  CypherLocalTime,
  CypherNode,
  CypherPath,
  CypherPoint,
  CypherRelationship,
  CypherTime,
} from "../cypher-values.js";
import { CyphraValidationError, UnsupportedFeatureError } from "../orm/errors.js";

describe("FalkorDB parameters", () => {
  it("writes literals: floats for numbers, integers for CypherInteger and bigint", () => {
    expect(literal(2)).toBe("2.0");
    expect(literal(-0.5)).toBe("-0.5");
    expect(literal(1e21)).toBe("1e+21");
    expect(literal(new CypherInteger(7))).toBe("7");
    expect(literal(-(2n ** 63n))).toBe("-9223372036854775808");
    expect(literal('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(literal([true, null, { k: 1, "odd key": "x" }])).toBe(
      '[true, null, {k: 1.0, `odd key`: "x"}]',
    );
    expect(literal(new Float32Array([0.5]))).toBe("[0.5]");
    expect(() => literal(Number.NaN)).toThrow(CyphraValidationError);
    expect(() => literal({ "a`b": 1 })).toThrow(CyphraValidationError);
    expect(() => literal(new Map())).toThrow(CyphraValidationError);
  });

  it("writes temporal values as their ISO 8601 text, DateTime in UTC with milliseconds", () => {
    expect(literal(new CypherDateTime(2024, 3, 10, 9, 30, 15, 123_000_000, 7200))).toBe(
      '"2024-03-10T07:30:15.123Z"',
    );
    expect(literal(new Date("2024-03-10T07:30:15Z"))).toBe('"2024-03-10T07:30:15.000Z"');
    expect(literal(new CypherDate(2024, 2, 29))).toBe('"2024-02-29"');
    expect(literal(new CypherLocalDateTime(2024, 3, 10, 7, 30, 15, 500_000_000))).toBe(
      '"2024-03-10T07:30:15.5"',
    );
    expect(literal(new CypherLocalTime(7, 30, 0, 0))).toBe('"07:30:00"');
    expect(literal(new CypherTime(7, 30, 0, 0, -18000))).toBe('"07:30:00-05:00"');
    expect(literal(new CypherDuration(14, 3, 3600, 0))).toBe('"P1Y2M3DT1H"');
  });

  it("refuses points", () => {
    expect(() => literal(new CypherPoint(4326, 2.35, 48.85))).toThrow(UnsupportedFeatureError);
  });

  it("rejects strings containing NUL with a clear validation error", () => {
    const nul = "a\u0000b";
    expect(() => literal(nul)).toThrow(CyphraValidationError);
    expect(() => literal(nul)).toThrow(/NUL character/);
    expect(() => literal(["ok", nul])).toThrow(CyphraValidationError);
    expect(() => literal({ k: { deep: [nul] } })).toThrow(CyphraValidationError);
    expect(() => literal({ [nul]: 1 })).toThrow(/map key name contains a NUL/);
    expect(() => paramsHeader({ [nul]: 1 })).toThrow(/parameter name contains a NUL/);
    expect(() => paramsHeader({ s: nul })).toThrow(CyphraValidationError);
    // Other control characters and hostile text are still accepted.
    expect(literal('x"\\\n\u0001')).toBe('"x\\"\\\\\n\u0001"');
  });

  it("builds the CYPHER header", () => {
    expect(paramsHeader({})).toBe("");
    expect(paramsHeader({ p0: "x", "odd name": new CypherInteger(1), skip: undefined })).toBe(
      'CYPHER p0="x" `odd name`=1 ',
    );
  });
});

describe("FalkorDB replies", () => {
  it("decodes integers, nodes, edges and paths", () => {
    expect(decodeValue(5n)).toEqual(new CypherInteger(5n));
    expect(decodeValue(1.5)).toBe(1.5);
    const a = { id: 1, labels: ["User"], properties: { n: 2n } };
    const b = { id: 2, labels: ["User"], properties: {} };
    const r = { id: 7, relationshipType: "F", sourceId: 1, destinationId: 2, properties: {} };
    const node = decodeValue(a) as CypherNode;
    expect(node).toBeInstanceOf(CypherNode);
    expect(node.elementId).toBe("1");
    expect(node.properties).toEqual({ n: new CypherInteger(2n) });
    const edge = decodeValue(r) as CypherRelationship;
    expect(edge).toBeInstanceOf(CypherRelationship);
    expect([edge.type, edge.startNodeElementId, edge.endNodeElementId]).toEqual(["F", "1", "2"]);
    const path = decodeValue({ nodes: [a, b], edges: [r] }) as CypherPath;
    expect(path).toBeInstanceOf(CypherPath);
    expect(path.length).toBe(1);
    // A map that only looks partly like a node stays a map.
    expect(decodeValue({ id: 1, labels: [] })).toEqual({ id: 1, labels: [] });
  });
});
