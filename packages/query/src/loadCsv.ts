import type { CompiledCypher } from "./cypher.js";

function assertCypherIdentifier(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label}: invalid identifier ${JSON.stringify(name)}`);
  }
}

/** Allowlisted single-character field terminators emitted as Cypher string literals (not user-provided text). */
export type LoadCsvFieldTerminator = "comma" | "semicolon" | "pipe" | "tab";

function fieldTerminatorClause(t: LoadCsvFieldTerminator): string {
  const ch =
    t === "comma"
      ? ","
      : t === "semicolon"
        ? ";"
        : t === "pipe"
          ? "|"
          : "\u0009";
  return ` FIELDTERMINATOR '${ch}'`;
}

/**
 * Emits **`LOAD CSV [WITH HEADERS] FROM $urlKey AS rowAlias`** with the URL (or file URI string) bound as a parameter.
 * This is a **clause fragment** — concatenate **`MERGE`**, **`WITH`**, etc., or wrap with **`cypher`** for the rest of the import.
 *
 * **`withHeaders`** defaults to **`true`** so each **`row`** is a map; set **`false`** for list-shaped rows.
 *
 * Server rules for **`file:///`** vs **`https://`** URLs follow the [Neo4j Cypher manual](https://neo4j.com/docs/cypher-manual/current/clauses/load-csv/).
 */
export function compileLoadCsvFrom(
  url: unknown,
  rowAlias: string,
  options?: {
    readonly withHeaders?: boolean;
    readonly urlParamKey?: string;
    readonly fieldTerminator?: LoadCsvFieldTerminator;
  },
): CompiledCypher {
  assertCypherIdentifier(rowAlias, "compileLoadCsvFrom(rowAlias)");
  const urlParamKey = options?.urlParamKey ?? "csvUrl";
  assertCypherIdentifier(urlParamKey, "compileLoadCsvFrom(urlParamKey)");
  const withHeaders = options?.withHeaders ?? true;
  const head = withHeaders ? "LOAD CSV WITH HEADERS" : "LOAD CSV";
  let text = `${head} FROM $${urlParamKey} AS ${rowAlias}`;
  if (options?.fieldTerminator !== undefined) {
    text += fieldTerminatorClause(options.fieldTerminator);
  }
  return {
    text,
    params: { [urlParamKey]: url },
  };
}
