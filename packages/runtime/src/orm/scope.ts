/**
 * Rules the engine ANDs into the statements it compiles (row-level scoping), for layers built on
 * the client such as `@cyphra/graphql`'s native API. See {@link EngineRules}.
 *
 * @packageDocumentation
 */

/** The operations a rule restricts. */
export type RuleOperation = "read" | "update" | "delete";

/**
 * One rule: `true` (no restriction), `false` (no node) or a `where` on the model (the nodes it
 * matches). A `where` is compiled like any other, with its values as parameters; it is trusted
 * (rules do not apply inside it).
 */
export type RuleValue = boolean | Readonly<Record<string, unknown>>;

/** The rules of one model, per operation. */
export type ModelRules = { readonly [Op in RuleOperation]?: RuleValue };

/**
 * Rules per model name (`{ Post: { read: { published: true } } }`), ANDed into every place a
 * statement matches nodes of that model:
 *
 * - `read`: the root of `findMany` / `findFirst` / `findUnique` / `count` / `aggregate` /
 *   `groupBy` / `search` / `findSimilar`, the start and end nodes of `traverse` / `shortestPath`,
 *   every relation load (`select` / `include`, at any depth), relation filter (`some` / `none` /
 *   `every` / `is` / `isNot`), `_count`, `orderBy` on a relation, `groupBy` on a relation, and the
 *   targets of nested `connect` / `disconnect` / `set`;
 * - `update`: the nodes `update` / `updateMany` / `upsert` match;
 * - `delete`: the nodes `delete` / `deleteMany` match.
 *
 * A rule on an interface applies to every node implementing it; a node matched through an
 * interface or a union gets its own model's rules too. Intermediate nodes of traversal paths are not
 * filtered.
 */
export type EngineRules = { readonly [model: string]: ModelRules | undefined };

/** The rule operations, for validation. */
export const RULE_OPERATIONS: readonly RuleOperation[] = ["read", "update", "delete"];
