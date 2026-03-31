import { describe, expect, it } from "vitest";
import { compilePointCartesian2D, compilePointWGS84 } from "./spatialPoint.js";

describe("spatialPoint", () => {
  it("compilePointCartesian2D", () => {
    expect(compilePointCartesian2D(1, 2)).toEqual({
      text: "point({ x: $px, y: $py })",
      params: { px: 1, py: 2 },
    });
  });

  it("compilePointWGS84 with and without height", () => {
    expect(compilePointWGS84(1, 2)).toEqual({
      text: "point({ latitude: $plat, longitude: $plon })",
      params: { plat: 1, plon: 2 },
    });
    expect(compilePointWGS84(1, 2, 3)).toEqual({
      text: "point({ latitude: $plat, longitude: $plon, height: $pheight })",
      params: { plat: 1, plon: 2, pheight: 3 },
    });
  });
});
