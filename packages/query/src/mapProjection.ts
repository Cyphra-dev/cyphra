/**
 * Neo4j **map projection** (Cypher Manual): **`variable { .prop1, .prop2 }`** inside **`RETURN`** / expressions.
 */

function assertIdentifier(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label}: invalid identifier ${JSON.stringify(name)}`);
  }
}

/**
 * @param variable - Bound variable (e.g. **`n`**).
 * @param properties - Property names; emits **`.name`** segments (not parameterized).
 */
export function compileMapProjection(variable: string, properties: readonly string[]): string {
  assertIdentifier(variable, "compileMapProjection(variable)");
  if (properties.length === 0) {
    throw new Error("compileMapProjection: at least one property is required");
  }
  for (const p of properties) {
    assertIdentifier(p, "compileMapProjection(properties)");
  }
  return `${variable} { ${properties.map((p) => `.${p}`).join(", ")} }`;
}
