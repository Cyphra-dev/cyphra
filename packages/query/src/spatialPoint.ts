import type { CompiledCypher } from "./cypher.js";

/** Cartesian 2D `point({ x: $px, y: $py })`. */
export function compilePointCartesian2D(x: unknown, y: unknown): CompiledCypher {
  return {
    text: "point({ x: $px, y: $py })",
    params: { px: x, py: y },
  };
}

/**
 * WGS-84 `point({ latitude: $plat, longitude: $plon [, height: $pheight] })`.
 */
export function compilePointWGS84(
  latitude: unknown,
  longitude: unknown,
  height?: unknown,
): CompiledCypher {
  if (height === undefined) {
    return {
      text: "point({ latitude: $plat, longitude: $plon })",
      params: { plat: latitude, plon: longitude },
    };
  }
  return {
    text: "point({ latitude: $plat, longitude: $plon, height: $pheight })",
    params: { plat: latitude, plon: longitude, pheight: height },
  };
}
