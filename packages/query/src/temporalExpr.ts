/**
 * Neo4j temporal **current instant** expressions (no arguments).
 * Use in `SelectQuery.returnRawFields()` or raw fragments; values are evaluated in the query context.
 *
 * @see https://neo4j.com/docs/cypher-manual/current/functions/temporal/
 */

/** `date()` */
export function currentDateExpr(): string {
  return "date()";
}

/** `datetime()` */
export function currentDateTimeExpr(): string {
  return "datetime()";
}

/** `time()` */
export function currentTimeExpr(): string {
  return "time()";
}

/** `localdatetime()` */
export function currentLocalDateTimeExpr(): string {
  return "localdatetime()";
}

/** `localtime()` */
export function currentLocalTimeExpr(): string {
  return "localtime()";
}
