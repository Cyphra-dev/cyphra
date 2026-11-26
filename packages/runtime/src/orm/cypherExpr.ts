/**
 * Cypher expressions in ORM arguments (internal engine entries): a Cypher fragment written by the
 * developer, compiled into the statement of an operation as a projected value, a filter or a sort
 * key. This is what `@cyphra/graphql`'s Cypher-backed fields (the native `@cypher`) compile to.
 *
 * A fragment is built by a tagged template ({@link cypherFragment}): its static text is the
 * developer's, every interpolated value is bound as a parameter (never spliced into the text),
 * except {@link CYPHER_NODE}, which stands for the variable of the node the fragment is evaluated
 * on, and nested fragments, which are inlined with the same rules.
 *
 * - `select: { followers: { $cypher: frag, $type: "Int" } }` projects the value under `followers`,
 *   decoded as a property of that scalar type (`$list: true`: a list of them).
 * - `select: { similar: { $cypher: frag, $model: "Movie", $many: true, select, where, orderBy,
 *   skip, take } }` projects the nodes the fragment returns (a node or a list of nodes), each with
 *   its own projection; the `read` rules of `Movie` filter them, as they do relation loads.
 * - `where: { $cypher: [{ expr: frag, type: "Int", filter: { gte: 3 } }] }` filters on the value.
 * - `orderBy: [{ $cypher: { expr: frag, type: "Int", sort: "desc" } }]` sorts by it.
 *
 * Rules do not apply inside the fragment itself: it is raw Cypher.
 *
 * @packageDocumentation
 * @internal
 */

import type { ResolvedScalarField, ScalarTypeName } from "@cyphra/schema";
import { CypherInteger } from "../cypher-values.js";
import { CyphraValidationError } from "./errors.js";
import { encodeScalar, utcDateTime } from "./values.js";

type AnyRecord = Record<string, unknown>;

const FRAGMENT = Symbol.for("cyphra.cypherFragment");
const NODE = Symbol.for("cyphra.cypherNode");

/** A Cypher fragment: static text parts and the values between them. */
export type CypherFragment = {
  readonly [FRAGMENT]: true;
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
};

/**
 * Stands for the variable of the node a fragment is evaluated on: `` cypherFragment`COUNT {
 * (${CYPHER_NODE})<-[:FOLLOWS]-() }` ``.
 */
export const CYPHER_NODE: { readonly [NODE]: true } = Object.freeze({ [NODE]: true as const });

/**
 * Build a {@link CypherFragment} from a template literal. Interpolated values are parameters;
 * {@link CYPHER_NODE} is the node's variable; a nested fragment is inlined.
 *
 * @internal
 * @experimental
 */
export function cypherFragment(
  strings: TemplateStringsArray,
  ...values: unknown[]
): CypherFragment {
  return Object.freeze({
    [FRAGMENT]: true as const,
    strings: Object.freeze([...strings]),
    values: Object.freeze([...values]),
  });
}

/** Whether `v` is a {@link CypherFragment} (of any copy of the runtime). */
export function isCypherFragment(v: unknown): v is CypherFragment {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<symbol, unknown>)[FRAGMENT] === true &&
    Array.isArray((v as AnyRecord).strings) &&
    Array.isArray((v as AnyRecord).values)
  );
}

function isNodeRef(v: unknown): boolean {
  return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[NODE] === true;
}

/**
 * A synthetic scalar field of `type`, to encode and decode the value of a Cypher expression like
 * a property of that type.
 */
export function cypherScalar(
  name: string,
  type: ScalarTypeName,
  list = false,
  enumValues?: readonly string[],
): ResolvedScalarField {
  // An enum without its values is compared and returned as text.
  const t = type === "Enum" && !enumValues ? "String" : type;
  return {
    kind: "scalar",
    name,
    type: t,
    optional: true,
    list,
    id: false,
    unique: false,
    index: false,
    ...(t === "Enum" ? { enum: name, enumValues } : {}),
  };
}

/**
 * A value as a Cypher parameter of `type` (an argument of a Cypher-backed field): encoded like a
 * property of that type (`Int` → a Cypher integer, `DateTime` from an ISO string, …).
 *
 * @internal
 * @experimental
 */
export function encodeCypherParam(
  type: ScalarTypeName,
  value: unknown,
  options: { list?: boolean; enumValues?: readonly string[]; where?: string } = {},
): unknown {
  if (value === undefined || value === null) return null;
  const field = cypherScalar(options.where ?? "argument", type, options.list, options.enumValues);
  return encodeScalar(field, value, "cypher");
}

/** A value interpolated into a fragment without a declared type. */
function bindValue(v: unknown): unknown {
  if (typeof v === "bigint") return new CypherInteger(v);
  if (v instanceof Date) return utcDateTime(v);
  if (Array.isArray(v)) return v.map(bindValue);
  return v;
}

/**
 * The Cypher text of `fragment` for the node bound to `alias`: its static text, `alias` for
 * {@link CYPHER_NODE}, a parameter of `bind` for every other value. Wrapped in parentheses.
 */
export function renderFragment(
  bind: (value: unknown) => string,
  alias: string,
  fragment: unknown,
  where: string,
): string {
  if (!isCypherFragment(fragment)) {
    throw new CyphraValidationError(`${where}: $cypher takes a Cypher fragment (cypher\`…\`).`);
  }
  const { strings, values } = fragment;
  if (strings.length !== values.length + 1 || strings.some((s) => typeof s !== "string")) {
    throw new CyphraValidationError(`${where}: malformed Cypher fragment.`);
  }
  let text = "";
  for (let i = 0; i < values.length; i++) {
    text += strings[i];
    const v = values[i];
    if (isNodeRef(v)) text += alias;
    else if (isCypherFragment(v)) text += renderFragment(bind, alias, v, where);
    else text += bind(bindValue(v));
  }
  text += strings[strings.length - 1];
  if (text.trim() === "") throw new CyphraValidationError(`${where}: empty Cypher fragment.`);
  return `(${text})`;
}

const SCALAR_TYPES: ReadonlySet<string> = new Set<ScalarTypeName>([
  "String",
  "Int",
  "Float",
  "Boolean",
  "DateTime",
  "Date",
  "LocalDateTime",
  "LocalTime",
  "Time",
  "Duration",
  "BigInt",
  "Json",
  "Point",
  "CartesianPoint",
  "Enum",
]);

/** The scalar type of a `$cypher` entry, checked. */
export function cypherType(v: unknown, where: string): ScalarTypeName {
  if (typeof v !== "string" || !SCALAR_TYPES.has(v)) {
    throw new CyphraValidationError(
      `${where}: $type must be a scalar type (${[...SCALAR_TYPES].join(", ")}).`,
    );
  }
  return v as ScalarTypeName;
}
