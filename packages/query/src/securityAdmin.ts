import type { CompiledCypher } from "./cypher.js";

function assertDbmsIdentifier(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label}: invalid identifier ${JSON.stringify(name)}`);
  }
}

/**
 * **`GRANT ROLE role TO user`** (single role, single user).
 *
 * @see https://neo4j.com/docs/cypher-manual/current/access-control/
 */
export function compileGrantRole(role: string, user: string): CompiledCypher {
  assertDbmsIdentifier(role, "compileGrantRole(role)");
  assertDbmsIdentifier(user, "compileGrantRole(user)");
  return { text: `GRANT ROLE ${role} TO ${user}`, params: {} };
}

/**
 * **`REVOKE ROLE role FROM user`** (single role, single user).
 */
export function compileRevokeRole(role: string, user: string): CompiledCypher {
  assertDbmsIdentifier(role, "compileRevokeRole(role)");
  assertDbmsIdentifier(user, "compileRevokeRole(user)");
  return { text: `REVOKE ROLE ${role} FROM ${user}`, params: {} };
}

/**
 * **`DENY ACCESS ON DATABASE database TO user`** (database name and user as plain identifiers).
 */
export function compileDenyAccessOnDatabase(database: string, user: string): CompiledCypher {
  assertDbmsIdentifier(database, "compileDenyAccessOnDatabase(database)");
  assertDbmsIdentifier(user, "compileDenyAccessOnDatabase(user)");
  return { text: `DENY ACCESS ON DATABASE ${database} TO ${user}`, params: {} };
}
