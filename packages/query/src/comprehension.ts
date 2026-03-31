import type { CompiledCypher } from "./cypher.js";
import { compileWhereFragment, type WherePredicate } from "./builder.js";

function assertCypherIdentifier(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label}: invalid identifier ${JSON.stringify(name)}`);
  }
}

/**
 * Emits the **`variable IN $listKey WHERE …`** portion of a Cypher list comprehension
 * **`[ variable IN $listKey WHERE … | expr ]`** (the Neo4j **`FILTER`** role in that position).
 *
 * Merge {@link CompiledCypher.params} into your outer query; concatenate **`text`** inside **`[ … ]`**
 * with your projection expression after **`|`**.
 *
 * Predicates use the same builders as {@link SelectQuery.where}; use {@link bareVar} for the item variable
 * when it is a scalar element (e.g. **`gt(bareVar("n"), 0)`**). For maps/nodes in the list, use **`prop(item, "field")`**.
 */
export function compileComprehensionFilterClause(
  itemVariable: string,
  listParamKey: string,
  listValue: unknown,
  predicates: WherePredicate[],
): CompiledCypher {
  assertCypherIdentifier(itemVariable, "compileComprehensionFilterClause(itemVariable)");
  assertCypherIdentifier(listParamKey, "compileComprehensionFilterClause(listParamKey)");
  const { text: whereSql, params: whereParams } = compileWhereFragment(predicates);
  if (!whereSql) {
    throw new Error("compileComprehensionFilterClause: at least one predicate is required");
  }
  if (Object.prototype.hasOwnProperty.call(whereParams, listParamKey)) {
    throw new Error(
      `compileComprehensionFilterClause: list param key ${JSON.stringify(listParamKey)} collides with WHERE parameter keys`,
    );
  }
  return {
    text: `${itemVariable} IN $${listParamKey} WHERE ${whereSql}`,
    params: { [listParamKey]: listValue, ...whereParams },
  };
}
