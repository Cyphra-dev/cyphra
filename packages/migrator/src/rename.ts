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

/** Options of {@link compileRenameRelationshipType}. */
export type RenameRelationshipTypeOptions = {
  /** Current relationship type. */
  readonly from: string;
  /** New relationship type. */
  readonly to: string;
  /** Only the edges starting at nodes with this label (default: any start node). */
  readonly startLabel?: string;
  /** Only the edges ending at nodes with this label (default: any end node). */
  readonly endLabel?: string;
};

/**
 * Build Cypher to rename a relationship type. A relationship's type cannot change, so each edge is
 * recreated with the new type and the same properties, then deleted (names are quoted).
 *
 * @example
 * ```ts
 * compileRenameRelationshipType({ from: "AUTHORED", to: "WROTE", startLabel: "User", endLabel: "Post" });
 * // MATCH (a:`User`)-[r:`AUTHORED`]->(b:`Post`) CREATE (a)-[n:`WROTE`]->(b) SET n = properties(r) DELETE r
 * ```
 */
export function compileRenameRelationshipType(opts: RenameRelationshipTypeOptions): CompiledCypher {
  // Quoted, so a type that is not an identifier (`HAS-TAG`) works too.
  const q = (id: string) => "`" + id.replace(/`/g, "``") + "`";
  if (!opts.from || !opts.to) throw new Error("renameRelationshipType: from and to are required.");
  const end = (v: string, label: string | undefined) => (label ? `(${v}:${q(label)})` : `(${v})`);
  return {
    text: `MATCH ${end("a", opts.startLabel)}-[r:${q(opts.from)}]->${end("b", opts.endLabel)} CREATE (a)-[n:${q(opts.to)}]->(b) SET n = properties(r) DELETE r`,
    params: {},
  };
}
