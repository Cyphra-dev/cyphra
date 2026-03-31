/**
 * Result of compiling a tagged Cypher template: query text and Neo4j parameters.
 * Values from `${…}` are **never** concatenated as raw Cypher — only bound as parameters.
 */
export type CompiledCypher = {
  readonly text: string;
  readonly params: Readonly<Record<string, unknown>>;
};

/**
 * Prefix every key in `compiled.params` with `keyPrefix` and rewrite `$key` occurrences in `compiled.text`
 * (longest keys first). Use when composing multiple compiled fragments so Neo4j parameter names stay unique.
 *
 * @param keyPrefix - Must match `/^[A-Za-z_][A-Za-z0-9_]*_$/` (identifier fragment ending with `_`).
 */
export function remapCompiledCypherParamKeys(
  compiled: CompiledCypher,
  keyPrefix: string,
): CompiledCypher {
  if (!/^[A-Za-z_][A-Za-z0-9_]*_$/.test(keyPrefix)) {
    throw new Error(
      "remapCompiledCypherParamKeys: keyPrefix must be an identifier fragment ending with '_'",
    );
  }
  const mapping: Record<string, string> = {};
  const allParams: Record<string, unknown> = {};
  for (const key of Object.keys(compiled.params)) {
    const newKey = `${keyPrefix}${key}`;
    mapping[key] = newKey;
    allParams[newKey] = compiled.params[key];
  }
  const keysByLen = Object.keys(mapping).sort((a, b) => b.length - a.length);
  let text = compiled.text;
  for (const oldK of keysByLen) {
    const newK = mapping[oldK]!;
    text = text.replaceAll(`$${oldK}`, `$${newK}`);
  }
  return { text, params: allParams };
}

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
