/**
 * Translates Better Auth's `where` clauses into Cyphra `where` objects.
 *
 * Foreign-key fields are edges, so a clause on `userId` becomes a relation filter on the related
 * node's referenced field: `{ user: { is: { id: value } } }`.
 */

import type { CleanedWhere } from "better-auth/adapters";
import type { FieldMapping, ModelMapping, ScalarMapping } from "./schema.js";

type Filter = Record<string, unknown>;

/** Coerce values Better Auth may send as strings (e.g. from query params) to the field type. */
export function coerceScalar(field: ScalarMapping, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (field.type === "Int" && /^-?\d+$/.test(value)) return Number(value);
  if (field.type === "Float" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  if (field.type === "Boolean" && (value === "true" || value === "false")) return value === "true";
  return value;
}

export function fieldOf(model: ModelMapping, field: string): FieldMapping {
  const f = model.fields.get(field);
  if (!f) throw new Error(`@cyphra/better-auth: unknown field "${model.dbName}.${field}".`);
  return f;
}

/**
 * The Cyphra filter for one clause on a scalar field (also used for the referenced field of a
 * foreign key), or `undefined` when the clause matches every row.
 */
function scalarFilter(w: CleanedWhere, field: ScalarMapping): unknown {
  const coerce = (v: unknown) => coerceScalar(field, v);
  const isText = (v: unknown) =>
    typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));
  const mode =
    w.mode === "insensitive" && field.type === "String" && !field.list && isText(w.value)
      ? { mode: "insensitive" }
      : {};
  const value = w.value;

  if (field.list) {
    if (w.operator === "eq")
      return Array.isArray(value) ? { equals: value.map(coerce) } : { has: coerce(value) };
    throw new Error(
      `@cyphra/better-auth: operator "${w.operator}" is not supported on list fields.`,
    );
  }

  switch (w.operator) {
    case "eq":
      return value === null ? null : { equals: coerce(value), ...mode };
    case "ne":
      return value === null ? { not: null } : { not: coerce(value), ...mode };
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return { [w.operator]: coerce(value) };
    case "in":
    case "not_in": {
      const list = (Array.isArray(value) ? value : [value]).filter(
        (v) => v !== null && v !== undefined,
      );
      if (w.operator === "not_in" && list.length === 0) return undefined;
      return { [w.operator === "in" ? "in" : "notIn"]: list.map(coerce), ...mode };
    }
    case "contains":
      return { contains: String(value), ...mode };
    case "starts_with":
      return { startsWith: String(value), ...mode };
    case "ends_with":
      return { endsWith: String(value), ...mode };
    default:
      throw new Error(`@cyphra/better-auth: unsupported where operator "${String(w.operator)}".`);
  }
}

/** One Better Auth clause as a Cyphra `where` object (`{}` matches everything). */
function clauseWhere(
  model: ModelMapping,
  w: CleanedWhere,
  parentOf: (key: string) => ModelMapping,
): Filter {
  const field = fieldOf(model, w.field);
  if (field.kind === "scalar") {
    const f = scalarFilter(w, field);
    return f === undefined ? {} : { [field.name]: f };
  }
  // Foreign key → filter through the edge on the parent's referenced field.
  const parent = parentOf(field.parentKey);
  const ref = fieldOf(parent, field.refField);
  if (ref.kind !== "scalar")
    throw new Error("@cyphra/better-auth: references must target a scalar.");
  if (w.value === null && w.operator === "eq") return { [field.relation]: null };
  if (w.value === null && w.operator === "ne") return { [field.relation]: { isNot: null } };
  const f = scalarFilter(w, ref);
  if (f === undefined) return {};
  return { [field.relation]: { is: { [ref.name]: f } } };
}

/**
 * Better Auth's connector semantics (same as its Prisma adapter): every `AND` clause must
 * hold, and at least one `OR` clause must hold when there are any.
 */
export function toCyphraWhere(
  model: ModelMapping,
  where: readonly CleanedWhere[] | undefined,
  parentOf: (key: string) => ModelMapping,
): Filter {
  if (!where?.length) return {};
  const and = where.filter((w) => w.connector !== "OR").map((w) => clauseWhere(model, w, parentOf));
  const or = where.filter((w) => w.connector === "OR").map((w) => clauseWhere(model, w, parentOf));
  return {
    ...(and.length ? { AND: and } : {}),
    ...(or.length ? { OR: or } : {}),
  };
}
