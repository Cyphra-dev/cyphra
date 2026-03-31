import type { CompiledCypher } from "./cypher.js";
import { remapCompiledCypherParamKeys } from "./cypher.js";

function assertSchemaIdent(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label}: invalid identifier ${JSON.stringify(name)}`);
  }
}

/**
 * Cypher® 25+ constructs: {@link appendFinish | FINISH}, {@link compileSequentialNext | NEXT},
 * {@link compileWhenThenElse | WHEN … THEN … ELSE}, {@link compileMatchFilterReturn | FILTER},
 * {@link compileLetClause | LET}, and schema DDL ({@link compileCreateConstraintNodeUnique},
 * {@link compileCreateConstraintRelationshipUnique}, range indexes).
 *
 * @see https://neo4j.com/docs/cypher-manual/25/
 */

export type LetBinding = {
  readonly variable: string;
  readonly expression: CompiledCypher;
};

/**
 * **`LET var = expr [, var2 = expr2 …]`** — each binding’s expression is compiled separately; parameters are
 * prefixed per binding (`l0_`, `l1_`, …) so they stay unique when composed.
 */
export function compileLetClause(bindings: readonly LetBinding[]): CompiledCypher {
  if (bindings.length === 0) {
    throw new Error("compileLetClause: at least one binding is required");
  }
  const params: Record<string, unknown> = {};
  const parts: string[] = [];
  bindings.forEach((b, i) => {
    assertSchemaIdent(b.variable, "compileLetClause(variable)");
    const remapped = remapCompiledCypherParamKeys(b.expression, `l${i}_`);
    parts.push(`${b.variable} = ${remapped.text.trim()}`);
    Object.assign(params, remapped.params);
  });
  return { text: `LET ${parts.join(", ")}`, params };
}

/** Append **`FINISH`** (no result set; side effects still run). */
export function appendFinish(clause: CompiledCypher): CompiledCypher {
  return {
    text: `${clause.text.trimEnd()} FINISH`,
    params: { ...clause.params },
  };
}

/** Compose two self-contained query segments with **`NEXT`** (right-hand parameters remapped). */
export function compileSequentialNext(left: CompiledCypher, right: CompiledCypher): CompiledCypher {
  const rightR = remapCompiledCypherParamKeys(right, "next_");
  return {
    text: `${left.text.trimEnd()} NEXT ${rightR.text.trimStart()}`,
    params: { ...left.params, ...rightR.params },
  };
}

export type WhenBranch = {
  readonly predicate: string;
  readonly then: CompiledCypher;
};

/**
 * Standalone **`WHEN predicate THEN query`** chain, optional **`ELSE`** (parameters remapped per branch).
 */
export function compileWhenThenElse(
  branches: readonly WhenBranch[],
  elseThen?: CompiledCypher,
): CompiledCypher {
  if (branches.length === 0) {
    throw new Error("compileWhenThenElse: at least one WHEN branch is required");
  }
  const params: Record<string, unknown> = {};
  const parts: string[] = [];
  branches.forEach((b, i) => {
    if (!b.predicate.trim()) {
      throw new Error("compileWhenThenElse: empty predicate");
    }
    const remapped = remapCompiledCypherParamKeys(b.then, `w${i}_`);
    parts.push(`WHEN ${b.predicate.trim()} THEN ${remapped.text.trim()}`);
    Object.assign(params, remapped.params);
  });
  if (elseThen) {
    const e = remapCompiledCypherParamKeys(elseThen, `wE_`);
    parts.push(`ELSE ${e.text.trim()}`);
    Object.assign(params, e.params);
  }
  return { text: parts.join(" "), params };
}

/**
 * Insert **`FILTER`** between a leading clause (typically **`MATCH`**) and the rest (e.g. **`RETURN`**).
 * The filter **predicate** is a compiled expression fragment (may contain parameters); it is remapped so it
 * does not collide with **`head`** or **`tail`**.
 */
export function compileMatchFilterReturn(
  head: CompiledCypher,
  filterPredicate: CompiledCypher,
  tail: CompiledCypher,
): CompiledCypher {
  if (!filterPredicate.text.trim()) {
    throw new Error("compileMatchFilterReturn: empty filter predicate");
  }
  const fR = remapCompiledCypherParamKeys(filterPredicate, "f_");
  const tR = remapCompiledCypherParamKeys(tail, "t_");
  return {
    text: `${head.text.trimEnd()} FILTER ${fR.text.trim()} ${tR.text.trimStart()}`,
    params: { ...head.params, ...fR.params, ...tR.params },
  };
}

/**
 * **`CREATE CONSTRAINT … FOR (var:Label) REQUIRE var.prop IS UNIQUE`** (optional **`IF NOT EXISTS`**).
 */
export function compileCreateConstraintNodeUnique(options: {
  readonly constraintName: string;
  readonly variable: string;
  readonly label: string;
  readonly property: string;
  readonly ifNotExists?: boolean;
}): CompiledCypher {
  assertSchemaIdent(options.constraintName, "compileCreateConstraintNodeUnique(constraintName)");
  assertSchemaIdent(options.variable, "compileCreateConstraintNodeUnique(variable)");
  assertSchemaIdent(options.label, "compileCreateConstraintNodeUnique(label)");
  assertSchemaIdent(options.property, "compileCreateConstraintNodeUnique(property)");
  const iff = options.ifNotExists ? " IF NOT EXISTS" : "";
  return {
    text: `CREATE CONSTRAINT ${options.constraintName}${iff} FOR (${options.variable}:${options.label}) REQUIRE ${options.variable}.${options.property} IS UNIQUE`,
    params: {},
  };
}

/**
 * Relationship property uniqueness: **`FOR ()-[rel:TYPE]-() REQUIRE rel.prop IS UNIQUE`** (Neo4j 5.7+).
 */
export function compileCreateConstraintRelationshipUnique(options: {
  readonly constraintName: string;
  readonly relVariable: string;
  readonly relType: string;
  readonly property: string;
  readonly ifNotExists?: boolean;
}): CompiledCypher {
  assertSchemaIdent(options.constraintName, "compileCreateConstraintRelationshipUnique(constraintName)");
  assertSchemaIdent(options.relVariable, "compileCreateConstraintRelationshipUnique(relVariable)");
  assertSchemaIdent(options.relType, "compileCreateConstraintRelationshipUnique(relType)");
  assertSchemaIdent(options.property, "compileCreateConstraintRelationshipUnique(property)");
  const iff = options.ifNotExists ? " IF NOT EXISTS" : "";
  return {
    text: `CREATE CONSTRAINT ${options.constraintName}${iff} FOR ()-[${options.relVariable}:${options.relType}]-() REQUIRE ${options.relVariable}.${options.property} IS UNIQUE`,
    params: {},
  };
}

/** **`CREATE RANGE INDEX … FOR (var:Label) ON (var.prop)`**. */
export function compileCreateRangeIndexNode(options: {
  readonly indexName: string;
  readonly variable: string;
  readonly label: string;
  readonly property: string;
  readonly ifNotExists?: boolean;
}): CompiledCypher {
  assertSchemaIdent(options.indexName, "compileCreateRangeIndexNode(indexName)");
  assertSchemaIdent(options.variable, "compileCreateRangeIndexNode(variable)");
  assertSchemaIdent(options.label, "compileCreateRangeIndexNode(label)");
  assertSchemaIdent(options.property, "compileCreateRangeIndexNode(property)");
  const iff = options.ifNotExists ? " IF NOT EXISTS" : "";
  return {
    text: `CREATE RANGE INDEX ${options.indexName}${iff} FOR (${options.variable}:${options.label}) ON (${options.variable}.${options.property})`,
    params: {},
  };
}

/** **`CREATE RANGE INDEX … FOR ()-[rel:TYPE]-() ON (rel.prop)`**. */
export function compileCreateRangeIndexRelationship(options: {
  readonly indexName: string;
  readonly relVariable: string;
  readonly relType: string;
  readonly property: string;
  readonly ifNotExists?: boolean;
}): CompiledCypher {
  assertSchemaIdent(options.indexName, "compileCreateRangeIndexRelationship(indexName)");
  assertSchemaIdent(options.relVariable, "compileCreateRangeIndexRelationship(relVariable)");
  assertSchemaIdent(options.relType, "compileCreateRangeIndexRelationship(relType)");
  assertSchemaIdent(options.property, "compileCreateRangeIndexRelationship(property)");
  const iff = options.ifNotExists ? " IF NOT EXISTS" : "";
  return {
    text: `CREATE RANGE INDEX ${options.indexName}${iff} FOR ()-[${options.relVariable}:${options.relType}]-() ON (${options.relVariable}.${options.property})`,
    params: {},
  };
}
