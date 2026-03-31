import type { CompiledCypher } from "./cypher.js";

/** Whitelisted read-only **`SHOW`** forms (Neo4j 5 admin / metadata). */
export type ShowAdminKind =
  | "CONSTRAINTS"
  | "INDEXES"
  | "DATABASES"
  | "USERS"
  | "ROLES"
  | "CURRENT_USER";

const SHOW_TEXT: Record<ShowAdminKind, string> = {
  CONSTRAINTS: "SHOW CONSTRAINTS",
  INDEXES: "SHOW INDEXES",
  DATABASES: "SHOW DATABASES",
  USERS: "SHOW USERS",
  ROLES: "SHOW ROLES",
  CURRENT_USER: "SHOW CURRENT USER",
};

/**
 * Compile a whitelisted **`SHOW …`** metadata statement (no parameters).
 * For other admin Cypher, use {@link cypher} or raw strings with review.
 */
export function compileShowAdmin(kind: ShowAdminKind): CompiledCypher {
  return { text: SHOW_TEXT[kind], params: {} };
}
