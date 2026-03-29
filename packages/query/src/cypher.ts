/**
 * Result of compiling a tagged Cypher template: query text and Neo4j parameters.
 * Values from `${…}` are **never** concatenated as raw Cypher — only bound as parameters.
 */
export type CompiledCypher = {
  readonly text: string;
  readonly params: Readonly<Record<string, unknown>>;
};

/**
 * Compile a template literal into Cypher with positional parameters `p0`, `p1`, …
 *
 * @param strings - Static fragments from the template literal.
 * @param values - Interpolated values; each becomes a separate parameter.
 * @returns Query text and a flat parameter map for `session.run`.
 *
 * @example
 * ```ts
 * const { text, params } = compileCypher(
 *   ["MATCH (u:User) WHERE u.id = ", " RETURN u"] as unknown as TemplateStringsArray,
 *   ["x-1"],
 * );
 * // text: "MATCH (u:User) WHERE u.id = $p0 RETURN u"
 * ```
 */
export function compileCypher(
  strings: TemplateStringsArray,
  values: readonly unknown[],
): CompiledCypher {
  if (values.length !== strings.length - 1) {
    throw new Error(
      `cypher template: expected ${strings.length - 1} interpolated values, got ${values.length}`,
    );
  }
  const params: Record<string, unknown> = {};
  let text = "";
  for (let i = 0; i < strings.length - 1; i++) {
    text += strings[i];
    const key = `p${i}`;
    params[key] = values[i];
    text += `$${key}`;
  }
  text += strings[strings.length - 1];
  return { text, params };
}

/**
 * Tagged template: `` cypher`MATCH (u) WHERE u.id = ${id}` ``
 *
 * @param strings - Template strings.
 * @param values - Bound parameters (never inlined as Cypher text).
 */
export function cypher(strings: TemplateStringsArray, ...values: unknown[]): CompiledCypher {
  return compileCypher(strings, values);
}
