import type { CompiledCypher } from "@cyphra/query";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdent(name: string, label: string): void {
  if (!IDENT.test(name)) {
    throw new Error(`Invalid Neo4j ${label} identifier: ${JSON.stringify(name)}`);
  }
}

/**
 * Build Cypher to rename a node label (validated identifiers only — not user-controlled strings).
 *
 * @param fromLabel - Current label.
 * @param toLabel - Target label.
 */
export function compileRenameLabel(fromLabel: string, toLabel: string): CompiledCypher {
  assertIdent(fromLabel, "label");
  assertIdent(toLabel, "label");
  return {
    text: `MATCH (n:\`${fromLabel}\`) SET n:\`${toLabel}\` REMOVE n:\`${fromLabel}\``,
    params: {},
  };
}

/**
 * Build Cypher to rename a property on nodes with a given label.
 *
 * @param label - Node label.
 * @param fromProp - Existing property key.
 * @param toProp - New property key.
 */
export function compileRenameProperty(
  label: string,
  fromProp: string,
  toProp: string,
): CompiledCypher {
  assertIdent(label, "label");
  assertIdent(fromProp, "property");
  assertIdent(toProp, "property");
  return {
    text: `MATCH (n:\`${label}\`) WHERE n.\`${fromProp}\` IS NOT NULL SET n.\`${toProp}\` = n.\`${fromProp}\` REMOVE n.\`${fromProp}\``,
    params: {},
  };
}
