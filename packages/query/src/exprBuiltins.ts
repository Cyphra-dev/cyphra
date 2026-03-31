import type { PropRef } from "./builder.js";

function ref(p: PropRef): string {
  return p.name === "" ? p.alias : `${p.alias}.${p.name}`;
}

/** `count(*)` */
export function countStar(): string {
  return "count(*)";
}

/** `count(variable)` — variable must be a plain Cypher identifier. */
export function countVariable(variable: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
    throw new Error(`countVariable: invalid identifier ${JSON.stringify(variable)}`);
  }
  return `count(${variable})`;
}

/** `count(DISTINCT expr)` */
export function countDistinct(p: PropRef): string {
  return `count(DISTINCT ${ref(p)})`;
}

/** `sum(alias.prop)` */
export function sumExpr(r: PropRef): string {
  return `sum(${ref(r)})`;
}

/** `avg(alias.prop)` */
export function avgExpr(r: PropRef): string {
  return `avg(${ref(r)})`;
}

/** `min(alias.prop)` */
export function minExpr(r: PropRef): string {
  return `min(${ref(r)})`;
}

/** `max(alias.prop)` */
export function maxExpr(r: PropRef): string {
  return `max(${ref(r)})`;
}

/** `collect(alias.prop)` */
export function collectExpr(r: PropRef): string {
  return `collect(${ref(r)})`;
}

/** `size(alias.prop)` for list properties */
export function sizeExpr(r: PropRef): string {
  return `size(${ref(r)})`;
}

/** `toLower(alias.prop)` */
export function toLowerExpr(r: PropRef): string {
  return `toLower(${ref(r)})`;
}

/** `toUpper(alias.prop)` */
export function toUpperExpr(r: PropRef): string {
  return `toUpper(${ref(r)})`;
}

/** `abs(alias.prop)` */
export function absExpr(r: PropRef): string {
  return `abs(${ref(r)})`;
}

/** `ceil(alias.prop)` */
export function ceilExpr(r: PropRef): string {
  return `ceil(${ref(r)})`;
}

/** `floor(alias.prop)` */
export function floorExpr(r: PropRef): string {
  return `floor(${ref(r)})`;
}

/** `round(alias.prop)` — single-argument form. */
export function roundExpr(r: PropRef): string {
  return `round(${ref(r)})`;
}

/** `sqrt(alias.prop)` */
export function sqrtExpr(r: PropRef): string {
  return `sqrt(${ref(r)})`;
}

/** `rand()` */
export function randExpr(): string {
  return "rand()";
}
