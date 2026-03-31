/**
 * Validated fragments for Neo4j **`MATCH`** [planner hints](https://neo4j.com/docs/cypher-manual/current/indexes/search-performance-indexes/index-hints/).
 * Emit plain Cypher text only (no parameters). Insert after the **`MATCH`** pattern and before **`WHERE`** / **`RETURN`**.
 */

function assertCypherIdentifier(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label}: invalid identifier ${JSON.stringify(name)}`);
  }
}

function matchHintIndexFragment(
  kind: "" | "RANGE " | "TEXT " | "POINT ",
  variable: string,
  labelOrRelType: string,
  properties: readonly string[],
  labelForErrors: string,
): string {
  assertCypherIdentifier(variable, `${labelForErrors}(variable)`);
  assertCypherIdentifier(labelOrRelType, `${labelForErrors}(labelOrRelType)`);
  if (properties.length === 0) {
    throw new Error(`${labelForErrors}: at least one property is required`);
  }
  for (const p of properties) {
    assertCypherIdentifier(p, `${labelForErrors}(properties)`);
  }
  return `USING ${kind}INDEX ${variable}:${labelOrRelType}(${properties.join(", ")})`;
}

/**
 * **`USING INDEX variable:LabelOrType(prop1, …)`** — node label, relationship type, or relationship index target.
 */
export function matchHintUsingIndex(
  variable: string,
  labelOrRelType: string,
  properties: readonly string[],
): string {
  return matchHintIndexFragment("", variable, labelOrRelType, properties, "matchHintUsingIndex");
}

/** **`USING RANGE INDEX variable:LabelOrType(prop1, …)`** — [Neo4j index hints](https://neo4j.com/docs/cypher-manual/current/indexes/search-performance-indexes/index-hints/). */
export function matchHintUsingRangeIndex(
  variable: string,
  labelOrRelType: string,
  properties: readonly string[],
): string {
  return matchHintIndexFragment(
    "RANGE ",
    variable,
    labelOrRelType,
    properties,
    "matchHintUsingRangeIndex",
  );
}

/** **`USING TEXT INDEX variable:LabelOrType(prop1, …)`**. */
export function matchHintUsingTextIndex(
  variable: string,
  labelOrRelType: string,
  properties: readonly string[],
): string {
  return matchHintIndexFragment(
    "TEXT ",
    variable,
    labelOrRelType,
    properties,
    "matchHintUsingTextIndex",
  );
}

/** **`USING POINT INDEX variable:LabelOrType(prop1, …)`**. */
export function matchHintUsingPointIndex(
  variable: string,
  labelOrRelType: string,
  properties: readonly string[],
): string {
  return matchHintIndexFragment(
    "POINT ",
    variable,
    labelOrRelType,
    properties,
    "matchHintUsingPointIndex",
  );
}

/** **`USING SCAN variable:LabelOrType`** — label scan hint (node or relationship pattern variable). */
export function matchHintUsingScan(variable: string, labelOrRelType: string): string {
  assertCypherIdentifier(variable, "matchHintUsingScan(variable)");
  assertCypherIdentifier(labelOrRelType, "matchHintUsingScan(labelOrRelType)");
  return `USING SCAN ${variable}:${labelOrRelType}`;
}

/** **`USING JOIN ON v1, v2, …`** — join-order hint for bound pattern variables. */
export function matchHintUsingJoin(variables: readonly string[]): string {
  if (variables.length === 0) {
    throw new Error("matchHintUsingJoin: at least one variable is required");
  }
  for (const v of variables) {
    assertCypherIdentifier(v, "matchHintUsingJoin(variables)");
  }
  return `USING JOIN ON ${variables.join(", ")}`;
}
