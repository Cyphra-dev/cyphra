/**
 * Rules the engine ANDs into the statements it compiles (row-level scoping), for layers built on
 * the client such as `@cyphra/graphql`'s native API. See {@link EngineRules}.
 *
 * @packageDocumentation
 */

/** The operations a `where` rule restricts. */
export type RuleOperation = "read" | "update" | "delete";

/**
 * One rule: `true` (no restriction), `false` (no node) or a `where` on the model (the nodes it
 * matches). A `where` is compiled like any other, with its values as parameters; it is trusted
 * (rules do not apply inside it).
 */
export type RuleValue = boolean | Readonly<Record<string, unknown>>;

/**
 * Whether a node may be created: `true`, `false`, or a function of the node's create `data` (the
 * client's, without nested relation writes resolved) returning one of them. Checked on every node
 * a statement creates, before anything runs.
 */
export type CreateRule = boolean | ((data: Readonly<Record<string, unknown>>) => boolean);

/** The rules of one model. */
export type ModelRules = {
  /** {@link RuleOperation} rules: the nodes reads, updates and deletes see. */
  readonly read?: RuleValue;
  readonly update?: RuleValue;
  readonly delete?: RuleValue;
  /** Whether nodes of the model may be created (root, nested, `createMany`, `upsert`). */
  readonly create?: CreateRule;
  /** Per relation field: the targets a nested `connect` / `set` may link (on top of `read`). */
  readonly connect?: { readonly [relation: string]: RuleValue | undefined };
  /**
   * Per relation field: the targets a nested `disconnect` / `set` may unlink (on top of `read`).
   * Edges to other targets are left alone; a to-one edge a write must replace (`connect` or
   * `create` on a to-one relation) fails the write with a `ForbiddenError` instead.
   */
  readonly disconnect?: { readonly [relation: string]: RuleValue | undefined };
  /**
   * `where` rules checked on the nodes a statement created or updated, after every write of the
   * statement (nested ones included): a node that does not match fails the operation with a
   * `ForbiddenError`, and the transaction is rolled back.
   */
  readonly after?: { readonly create?: RuleValue; readonly update?: RuleValue };
  /**
   * Per scalar field: the rows on which the field is readable (`false`: none). Elsewhere it reads
   * as `null` everywhere a statement reads it: projections (writes' results included), filters,
   * `orderBy`, aggregates and `groupBy` keys.
   */
  readonly fields?: { readonly [field: string]: RuleValue | undefined };
};

/**
 * Rules per model name (`{ Post: { read: { published: true } } }`), ANDed into every place a
 * statement matches nodes of that model:
 *
 * - `read`: the root of `findMany` / `findFirst` / `findUnique` / `count` / `aggregate` /
 *   `groupBy` / `search` / `findSimilar`, the start and end nodes of `traverse` / `shortestPath`,
 *   every relation load (`select` / `include`, at any depth), relation filter (`some` / `none` /
 *   `every` / `is` / `isNot`), `_count`, `orderBy` on a relation, `groupBy` on a relation, the
 *   targets of nested `connect` / `disconnect` / `set`, the nodes `update` / `delete` match (a
 *   node the request cannot read does not exist for it), and the result of a write (a written
 *   node the request cannot read is returned as `null`; batch `nodes` leave it out);
 * - `update`: the nodes `update` / `updateMany` / `upsert` match, and the target of a `connect`
 *   whose inverse relation is to-one (its edge is replaced);
 * - `delete`: the nodes `delete` / `deleteMany` match;
 * - `create`, `connect`, `disconnect`, `after`, `fields`: see {@link ModelRules}.
 *
 * A rule on an interface applies to every node implementing it; a node matched through an
 * interface or a union gets its own model's rules too. Intermediate nodes of traversal paths are not
 * filtered, and nodes an `onDelete: Cascade` reaches are deleted whatever their `delete` rules.
 */
export type EngineRules = { readonly [model: string]: ModelRules | undefined };

/** The `where` rule operations, for validation. */
export const RULE_OPERATIONS: readonly RuleOperation[] = ["read", "update", "delete"];

/** Every key of {@link ModelRules}, for validation. */
export const MODEL_RULE_KEYS = [
  "read",
  "update",
  "delete",
  "create",
  "connect",
  "disconnect",
  "after",
  "fields",
] as const;
