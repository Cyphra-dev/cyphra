/**
 * A small value tree shared by the operation codemod and the rules drafter: GraphQL argument
 * values (literals, variables, enum values) and v7 rule values (`"$jwt.sub"` references) read
 * into one shape, translated, then printed back as GraphQL or as TypeScript.
 *
 * @packageDocumentation
 */

import { Kind, type ConstValueNode, type ObjectFieldNode, type ValueNode } from "graphql";

/** One value: `loc` is the offset of its source node in the document, when it came from one. */
export type Value =
  | { readonly k: "null"; readonly loc?: number }
  | { readonly k: "string"; readonly v: string; readonly loc?: number }
  | { readonly k: "number"; readonly raw: string; readonly float: boolean; readonly loc?: number }
  | { readonly k: "boolean"; readonly v: boolean; readonly loc?: number }
  | { readonly k: "enum"; readonly v: string; readonly loc?: number }
  | { readonly k: "var"; readonly name: string; readonly loc?: number }
  /** A v7 rule reference: `$jwt.sub`, `$context.user.id`. */
  | { readonly k: "ref"; readonly path: string; readonly loc?: number }
  | { readonly k: "list"; readonly items: readonly Value[]; readonly loc?: number }
  | { readonly k: "obj"; readonly fields: readonly Field[]; readonly loc?: number };

/** One entry of an object value. */
export type Field = { readonly key: string; readonly value: Value; readonly loc?: number };

export type ObjValue = Extract<Value, { k: "obj" }>;

export const NULL: Value = { k: "null" };

export function obj(fields: readonly Field[], loc?: number): ObjValue {
  return { k: "obj", fields, loc };
}

export function field(key: string, value: Value, loc?: number): Field {
  return { key, value, loc };
}

export function list(items: readonly Value[], loc?: number): Value {
  return { k: "list", items, loc };
}

export function num(n: number): Value {
  return { k: "number", raw: String(n), float: !Number.isInteger(n) };
}

export function isObj(v: Value | undefined): v is ObjValue {
  return v?.k === "obj";
}

export function isEmptyObj(v: Value): boolean {
  return v.k === "obj" && v.fields.length === 0;
}

/** The entry `key` of an object value. */
export function get(v: Value | undefined, key: string): Value | undefined {
  return v?.k === "obj" ? v.fields.find((f) => f.key === key)?.value : undefined;
}

/** A value read from a GraphQL literal (variables stay variables). */
export function fromAst(node: ValueNode | ConstValueNode): Value {
  const loc = node.loc?.start;
  switch (node.kind) {
    case Kind.NULL:
      return { k: "null", loc };
    case Kind.STRING:
      return { k: "string", v: node.value, loc };
    case Kind.INT:
      return { k: "number", raw: node.value, float: false, loc };
    case Kind.FLOAT:
      return { k: "number", raw: node.value, float: true, loc };
    case Kind.BOOLEAN:
      return { k: "boolean", v: node.value, loc };
    case Kind.ENUM:
      return { k: "enum", v: node.value, loc };
    case Kind.VARIABLE:
      return { k: "var", name: node.name.value, loc };
    case Kind.LIST:
      return { k: "list", items: node.values.map(fromAst), loc };
    case Kind.OBJECT:
      return {
        k: "obj",
        fields: node.fields.map((f: ObjectFieldNode) => ({
          key: f.name.value,
          value: fromAst(f.value),
          loc: f.loc?.start,
        })),
        loc,
      };
  }
}

/**
 * A value read from a v7 rule (`@authorization(filter: [{ where: … }])` as the v7 model holds
 * it): `"$jwt.<claim>"` / `"$context.<path>"` strings become references.
 */
export function fromJs(v: unknown): Value {
  if (v === null || v === undefined) return NULL;
  if (typeof v === "string") {
    return /^\$(jwt|context)\./.test(v) ? { k: "ref", path: v } : { k: "string", v };
  }
  if (typeof v === "number") return num(v);
  if (typeof v === "bigint") return { k: "number", raw: v.toString(), float: false };
  if (typeof v === "boolean") return { k: "boolean", v };
  if (Array.isArray(v)) return list(v.map(fromJs));
  if (typeof v === "object") {
    return obj(
      Object.entries(v as Record<string, unknown>).map(([key, x]) => field(key, fromJs(x))),
    );
  }
  return { k: "string", v: String(v) };
}

/** The value as a GraphQL literal. */
export function toAst(v: Value): ValueNode {
  switch (v.k) {
    case "null":
      return { kind: Kind.NULL };
    case "string":
      return { kind: Kind.STRING, value: v.v };
    case "number":
      return v.float ? { kind: Kind.FLOAT, value: v.raw } : { kind: Kind.INT, value: v.raw };
    case "boolean":
      return { kind: Kind.BOOLEAN, value: v.v };
    case "enum":
      return { kind: Kind.ENUM, value: v.v };
    case "var":
      return { kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: v.name } };
    case "ref":
      // References only exist in rules; in an operation they are plain strings.
      return { kind: Kind.STRING, value: v.path };
    case "list":
      return { kind: Kind.LIST, values: v.items.map(toAst) };
    case "obj":
      return {
        kind: Kind.OBJECT,
        fields: v.fields.map((f) => ({
          kind: Kind.OBJECT_FIELD,
          name: { kind: Kind.NAME, value: f.key },
          value: toAst(f.value),
        })),
      };
  }
}

/** Whether the value contains a variable. */
export function hasVariable(v: Value): boolean {
  if (v.k === "var") return true;
  if (v.k === "list") return v.items.some(hasVariable);
  if (v.k === "obj") return v.fields.some((f) => hasVariable(f.value));
  return false;
}

/** Whether the value contains a `$jwt` / `$context` reference. */
export function hasRef(v: Value): boolean {
  if (v.k === "ref") return true;
  if (v.k === "list") return v.items.some(hasRef);
  if (v.k === "obj") return v.fields.some((f) => hasRef(f.value));
  return false;
}

/**
 * Merge object values into one (an AND of filters): keys that do not collide are merged, the
 * others go into `AND`.
 */
export function andAll(parts: readonly ObjValue[]): ObjValue {
  const fields: Field[] = [];
  const extra: ObjValue[] = [];
  for (const p of parts) {
    const collides = p.fields.some((f) => fields.some((g) => g.key === f.key));
    if (collides) extra.push(p);
    else fields.push(...p.fields);
  }
  if (!extra.length) return obj(fields);
  const and = fields.findIndex((f) => f.key === "AND");
  const items = [...(and >= 0 ? listItems(fields[and]!.value) : []), ...extra];
  const rest = fields.filter((_, i) => i !== and);
  return obj([...rest, field("AND", list(items))]);
}

function listItems(v: Value): readonly Value[] {
  return v.k === "list" ? v.items : [v];
}
