import type { CompiledCypher } from "./cypher.js";
import { compileWhereFragment, type WherePredicate } from "./builder.js";

function assertCypherIdentifier(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label}: invalid identifier ${JSON.stringify(name)}`);
  }
}

/** `CREATE (n:Label) SET n += $props` */
export function compileCreate(label: string, props: Record<string, unknown>, alias = "n"): CompiledCypher {
  return {
    text: `CREATE (${alias}:${label}) SET ${alias} += $props`,
    params: { props },
  };
}

/** Options for {@link compileMergeSet} when using **`ON CREATE` / `ON MATCH`**. */
export type CompileMergeSetOptions = {
  readonly alias?: string;
  readonly onCreate?: Record<string, unknown>;
  readonly onMatch?: Record<string, unknown>;
};

/**
 * `MERGE (n:Label { key: $keyVal }) SET n += $props`, or with modifiers:
 * `MERGE … ON CREATE SET n += $onCreateProps ON MATCH SET n += $onMatchProps` (optional trailing `SET` when **`props`** is non-empty).
 *
 * The fifth argument is either an alias string (legacy) or an options object with **`alias`**, **`onCreate`**, **`onMatch`**.
 */
export function compileMergeSet(
  label: string,
  key: string,
  keyValue: unknown,
  props: Record<string, unknown>,
  fifth?: string | CompileMergeSetOptions,
): CompiledCypher {
  assertCypherIdentifier(label, "compileMergeSet(label)");
  assertCypherIdentifier(key, "compileMergeSet(key)");
  let alias = "n";
  let onCreate: Record<string, unknown> | undefined;
  let onMatch: Record<string, unknown> | undefined;
  if (typeof fifth === "string") {
    alias = fifth;
  } else if (fifth !== undefined) {
    alias = fifth.alias ?? "n";
    onCreate = fifth.onCreate;
    onMatch = fifth.onMatch;
  }
  assertCypherIdentifier(alias, "compileMergeSet(alias)");

  const params: Record<string, unknown> = { keyVal: keyValue };
  let text = `MERGE (${alias}:${label} { ${key}: $keyVal })`;
  const hasModifiers = onCreate !== undefined || onMatch !== undefined;

  if (onCreate !== undefined) {
    params.onCreateProps = onCreate;
    text += ` ON CREATE SET ${alias} += $onCreateProps`;
  }
  if (onMatch !== undefined) {
    params.onMatchProps = onMatch;
    text += ` ON MATCH SET ${alias} += $onMatchProps`;
  }

  if (Object.keys(props).length > 0 || !hasModifiers) {
    params.props = props;
    text += ` SET ${alias} += $props`;
  }

  return { text, params };
}

function relationshipOutCore(
  fromAlias: string,
  relAlias: string,
  relType: string,
  toAlias: string,
  verb: "CREATE" | "MERGE",
): string {
  assertCypherIdentifier(fromAlias, `${verb} relationship (fromAlias)`);
  assertCypherIdentifier(relAlias, `${verb} relationship (relAlias)`);
  assertCypherIdentifier(relType, `${verb} relationship (relType)`);
  assertCypherIdentifier(toAlias, `${verb} relationship (toAlias)`);
  return `${verb} (${fromAlias})-[${relAlias}:${relType}]->(${toAlias})`;
}

function relationshipInCore(
  endNodeAlias: string,
  relAlias: string,
  relType: string,
  startNodeAlias: string,
  verb: "CREATE" | "MERGE",
): string {
  assertCypherIdentifier(endNodeAlias, `${verb} relationship in (endNode)`);
  assertCypherIdentifier(relAlias, `${verb} relationship in (relAlias)`);
  assertCypherIdentifier(relType, `${verb} relationship in (relType)`);
  assertCypherIdentifier(startNodeAlias, `${verb} relationship in (startNode)`);
  return `${verb} (${endNodeAlias})<-[${relAlias}:${relType}]-(${startNodeAlias})`;
}

function withRelProps(
  core: string,
  relAlias: string,
  props: Record<string, unknown>,
): CompiledCypher {
  if (Object.keys(props).length === 0) {
    return { text: core, params: {} };
  }
  return {
    text: `${core} SET ${relAlias} += $props`,
    params: { props },
  };
}

/**
 * `MERGE (from)-[rel:REL_TYPE]->(to) [SET rel += $props]` between variables bound earlier in the query
 * (prefix with **`MATCH`** / **`MERGE`** on both endpoints). **`SET`** is omitted when **`props`** is empty.
 */
export function compileMergeRelationship(
  fromAlias: string,
  relAlias: string,
  relType: string,
  toAlias: string,
  props: Record<string, unknown> = {},
): CompiledCypher {
  const core = relationshipOutCore(fromAlias, relAlias, relType, toAlias, "MERGE");
  return withRelProps(core, relAlias, props);
}

/**
 * `CREATE (from)-[rel:TYPE]->(to) [SET rel += $props]` — endpoints must already be bound (e.g. after **`MERGE`**).
 * **`SET`** omitted when **`props`** is empty.
 */
export function compileCreateRelationship(
  fromAlias: string,
  relAlias: string,
  relType: string,
  toAlias: string,
  props: Record<string, unknown> = {},
): CompiledCypher {
  const core = relationshipOutCore(fromAlias, relAlias, relType, toAlias, "CREATE");
  return withRelProps(core, relAlias, props);
}

/**
 * `CREATE (endNode)<-[rel:TYPE]-(startNode) [SET rel += $props]` — edge **`startNode` → `endNode`** (incoming at **`endNode`**).
 */
export function compileCreateRelationshipIn(
  endNodeAlias: string,
  relAlias: string,
  relType: string,
  startNodeAlias: string,
  props: Record<string, unknown> = {},
): CompiledCypher {
  const core = relationshipInCore(endNodeAlias, relAlias, relType, startNodeAlias, "CREATE");
  return withRelProps(core, relAlias, props);
}

/**
 * `MERGE (endNode)<-[rel:TYPE]-(startNode) [SET rel += $props]` — same direction semantics as {@link compileCreateRelationshipIn}.
 */
export function compileMergeRelationshipIn(
  endNodeAlias: string,
  relAlias: string,
  relType: string,
  startNodeAlias: string,
  props: Record<string, unknown> = {},
): CompiledCypher {
  const core = relationshipInCore(endNodeAlias, relAlias, relType, startNodeAlias, "MERGE");
  return withRelProps(core, relAlias, props);
}

/**
 * `MATCH (n:Label) WHERE … DETACH DELETE n`
 *
 * @param label - Node label.
 * @param alias - Variable for the matched node.
 * @param predicates - AND-combined (same as {@link compileWhereFragment}).
 */
export function compileDetachDeleteWhere(
  label: string,
  alias: string,
  predicates: WherePredicate[],
): CompiledCypher {
  const { text: whereSql, params: whereParams } = compileWhereFragment(predicates);
  if (!whereSql) {
    throw new Error("compileDetachDeleteWhere: at least one WHERE predicate is required");
  }
  return {
    text: `MATCH (${alias}:${label}) WHERE ${whereSql} DETACH DELETE ${alias}`,
    params: whereParams,
  };
}

/** `MATCH (n:Label) WHERE … SET n += $props` */
export function compileSetWhere(
  label: string,
  alias: string,
  predicates: WherePredicate[],
  props: Record<string, unknown>,
): CompiledCypher {
  const { text: whereSql, params: whereParams } = compileWhereFragment(predicates);
  if (!whereSql) {
    throw new Error("compileSetWhere: at least one WHERE predicate is required");
  }
  const p = { ...whereParams, props };
  return {
    text: `MATCH (${alias}:${label}) WHERE ${whereSql} SET ${alias} += $props`,
    params: p,
  };
}

/**
 * `MATCH (n:Label) WHERE … DELETE n` — fails at runtime if relationships still attach to `n`
 * (use {@link compileDetachDeleteWhere} for cascade).
 */
export function compileDeleteWhere(
  label: string,
  alias: string,
  predicates: WherePredicate[],
): CompiledCypher {
  const { text: whereSql, params: whereParams } = compileWhereFragment(predicates);
  if (!whereSql) {
    throw new Error("compileDeleteWhere: at least one WHERE predicate is required");
  }
  return {
    text: `MATCH (${alias}:${label}) WHERE ${whereSql} DELETE ${alias}`,
    params: whereParams,
  };
}

/**
 * Anonymous-endpoint relationship shape for {@link compileDeleteRelationshipWhere},
 * {@link compileSetRelationshipWhere}, and {@link compileRemoveRelationshipProperties}.
 */
export type RelationshipEndpointsPattern = "out" | "in" | "undirected";

function matchAnonymousTypedRelationship(
  relAlias: string,
  relType: string,
  ends: RelationshipEndpointsPattern,
): string {
  assertCypherIdentifier(relAlias, "relationship MATCH (relAlias)");
  assertCypherIdentifier(relType, "relationship MATCH (relType)");
  switch (ends) {
    case "out":
      return `()-[${relAlias}:${relType}]->()`;
    case "in":
      return `()<-[${relAlias}:${relType}]-()`;
    case "undirected":
      return `()-[${relAlias}:${relType}]-()`;
    default: {
      const _ex: never = ends;
      throw new Error(String(_ex));
    }
  }
}

/**
 * `MATCH ()-[r:TYPE]->() WHERE … DELETE r` (default) — delete relationships by type and predicates.
 * Endpoints are anonymous; use {@link RelationshipEndpointsPattern} for incoming or undirected **`MATCH`**.
 */
export function compileDeleteRelationshipWhere(
  relType: string,
  relAlias: string,
  predicates: WherePredicate[],
  options?: { readonly ends?: RelationshipEndpointsPattern },
): CompiledCypher {
  const ends = options?.ends ?? "out";
  const pattern = matchAnonymousTypedRelationship(relAlias, relType, ends);
  const { text: whereSql, params: whereParams } = compileWhereFragment(predicates);
  if (!whereSql) {
    throw new Error("compileDeleteRelationshipWhere: at least one WHERE predicate is required");
  }
  return {
    text: `MATCH ${pattern} WHERE ${whereSql} DELETE ${relAlias}`,
    params: whereParams,
  };
}

/** `MATCH ()-[r:TYPE]-() WHERE … SET r += $props` — same endpoint options as {@link compileDeleteRelationshipWhere}. */
export function compileSetRelationshipWhere(
  relType: string,
  relAlias: string,
  predicates: WherePredicate[],
  props: Record<string, unknown>,
  options?: { readonly ends?: RelationshipEndpointsPattern },
): CompiledCypher {
  const ends = options?.ends ?? "out";
  const pattern = matchAnonymousTypedRelationship(relAlias, relType, ends);
  const { text: whereSql, params: whereParams } = compileWhereFragment(predicates);
  if (!whereSql) {
    throw new Error("compileSetRelationshipWhere: at least one WHERE predicate is required");
  }
  const p = { ...whereParams, props };
  return {
    text: `MATCH ${pattern} WHERE ${whereSql} SET ${relAlias} += $props`,
    params: p,
  };
}

/**
 * `MATCH ()-[r:TYPE]-() WHERE … REMOVE r.p0, …` — property names must be literal identifiers.
 */
export function compileRemoveRelationshipProperties(
  relType: string,
  relAlias: string,
  predicates: WherePredicate[],
  propertyNames: readonly string[],
  options?: { readonly ends?: RelationshipEndpointsPattern },
): CompiledCypher {
  if (propertyNames.length === 0) {
    throw new Error("compileRemoveRelationshipProperties: at least one property name is required");
  }
  for (const name of propertyNames) {
    assertCypherIdentifier(name, "compileRemoveRelationshipProperties");
  }
  const ends = options?.ends ?? "out";
  const pattern = matchAnonymousTypedRelationship(relAlias, relType, ends);
  const { text: whereSql, params: whereParams } = compileWhereFragment(predicates);
  if (!whereSql) {
    throw new Error("compileRemoveRelationshipProperties: at least one WHERE predicate is required");
  }
  const removeList = propertyNames.map((p) => `${relAlias}.${p}`).join(", ");
  return {
    text: `MATCH ${pattern} WHERE ${whereSql} REMOVE ${removeList}`,
    params: whereParams,
  };
}

/**
 * `MATCH (n:Label) WHERE … REMOVE n.p0, n.p1, …` — property names must be literal identifiers.
 */
export function compileRemoveProperties(
  label: string,
  alias: string,
  predicates: WherePredicate[],
  propertyNames: readonly string[],
): CompiledCypher {
  if (propertyNames.length === 0) {
    throw new Error("compileRemoveProperties: at least one property name is required");
  }
  for (const name of propertyNames) {
    assertCypherIdentifier(name, "compileRemoveProperties");
  }
  const { text: whereSql, params: whereParams } = compileWhereFragment(predicates);
  if (!whereSql) {
    throw new Error("compileRemoveProperties: at least one WHERE predicate is required");
  }
  const removeList = propertyNames.map((p) => `${alias}.${p}`).join(", ");
  return {
    text: `MATCH (${alias}:${label}) WHERE ${whereSql} REMOVE ${removeList}`,
    params: whereParams,
  };
}

/**
 * Batch upsert: `UNWIND $rows AS row MERGE (n:Label { key: row.key }) SET n += coalesce(row.patch, {})`.
 * Each element of `rows` must be a map with `mergeKey` present and optional `patch` map.
 */
export function compileUnwindMergeSet(
  label: string,
  mergeKey: string,
  rows: readonly Record<string, unknown>[],
  options?: { readonly alias?: string; readonly rowsParam?: string },
): CompiledCypher {
  assertCypherIdentifier(label, "compileUnwindMergeSet(label)");
  assertCypherIdentifier(mergeKey, "compileUnwindMergeSet(mergeKey)");
  const alias = options?.alias ?? "n";
  const rowsParam = options?.rowsParam ?? "rows";
  assertCypherIdentifier(alias, "compileUnwindMergeSet(alias)");
  assertCypherIdentifier(rowsParam, "compileUnwindMergeSet(rowsParam)");
  return {
    text: `UNWIND $${rowsParam} AS row MERGE (${alias}:${label} { ${mergeKey}: row.${mergeKey} }) SET ${alias} += coalesce(row.patch, {})`,
    params: { [rowsParam]: rows },
  };
}

/**
 * Batch upsert with **`FOREACH`**: `FOREACH (row IN $rows | MERGE (n:Label { key: row.key }) SET n += coalesce(row.patch, {}))`.
 * Same row shape as {@link compileUnwindMergeSet}; use **`FOREACH`** when **`UNWIND`** would change the outer row stream
 * (for example after a **`MATCH`** you need a single side-effect clause without expanding rows).
 */
export function compileForeachMergeSet(
  label: string,
  mergeKey: string,
  rows: readonly Record<string, unknown>[],
  options?: { readonly alias?: string; readonly rowsParam?: string },
): CompiledCypher {
  assertCypherIdentifier(label, "compileForeachMergeSet(label)");
  assertCypherIdentifier(mergeKey, "compileForeachMergeSet(mergeKey)");
  const alias = options?.alias ?? "n";
  const rowsParam = options?.rowsParam ?? "rows";
  assertCypherIdentifier(alias, "compileForeachMergeSet(alias)");
  assertCypherIdentifier(rowsParam, "compileForeachMergeSet(rowsParam)");
  return {
    text: `FOREACH (row IN $${rowsParam} | MERGE (${alias}:${label} { ${mergeKey}: row.${mergeKey} }) SET ${alias} += coalesce(row.patch, {}))`,
    params: { [rowsParam]: rows },
  };
}

/**
 * Emits **`FOREACH (relVar IN relationships(pathAlias) | DELETE relVar)`** with no extra parameters.
 * Compose after a **`MATCH`** (or similar) that binds **`pathAlias`** as a path value.
 */
export function compileForeachDeleteRelationshipsFromPath(
  pathAlias: string,
  relVar = "r",
): CompiledCypher {
  assertCypherIdentifier(pathAlias, "compileForeachDeleteRelationshipsFromPath(pathAlias)");
  assertCypherIdentifier(relVar, "compileForeachDeleteRelationshipsFromPath(relVar)");
  return {
    text: `FOREACH (${relVar} IN relationships(${pathAlias}) | DELETE ${relVar})`,
    params: {},
  };
}

/**
 * Batch delete: `UNWIND $ids AS id MATCH (n:Label) WHERE n.keyField = id DETACH DELETE n`.
 */
export function compileUnwindDetachDelete(
  label: string,
  keyField: string,
  ids: readonly unknown[],
  options?: { readonly alias?: string; readonly idsParam?: string },
): CompiledCypher {
  assertCypherIdentifier(label, "compileUnwindDetachDelete(label)");
  assertCypherIdentifier(keyField, "compileUnwindDetachDelete(keyField)");
  const alias = options?.alias ?? "n";
  const idsParam = options?.idsParam ?? "ids";
  assertCypherIdentifier(alias, "compileUnwindDetachDelete(alias)");
  assertCypherIdentifier(idsParam, "compileUnwindDetachDelete(idsParam)");
  return {
    text: `UNWIND $${idsParam} AS id MATCH (${alias}:${label}) WHERE ${alias}.${keyField} = id DETACH DELETE ${alias}`,
    params: { [idsParam]: [...ids] },
  };
}
