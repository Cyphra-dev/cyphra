/**
 * Cypher that converts data written by `neo4j-better-auth` (0.x) to the layout this adapter
 * uses.
 *
 * | neo4j-better-auth                           | @cyphra/better-auth                       |
 * | ------------------------------------------- | ----------------------------------------- |
 * | label = database model name (`user`)        | PascalCase label (`User`)                 |
 * | foreign key property + `HAS_*` edge         | `HAS_*` edge only                         |
 * | dates as ISO strings                        | `DateTime` values                         |
 * | numbers as floats                           | integers (`Int`)                          |
 *
 * @packageDocumentation
 */

import type { BetterAuthOptions } from "better-auth/types";
import { authSchema, type AuthSchemaOptions } from "./options.js";

function quote(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

/** neo4j-better-auth's relationship type for a child label (`session` → `HAS_SESSION`). */
function legacyEdgeType(childLabel: string): string {
  const core = childLabel
    .replace(/[^a-zA-Z0-9]/g, "_")
    .toUpperCase()
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return `HAS_${core || "RELATED"}`;
}

/** neo4j-better-auth's constraint / index names (`user_email_unique`, `session_userId_idx`). */
function legacyObjectName(...parts: string[]): string {
  return quote(parts.join("_").replace(/[^a-zA-Z0-9_]/g, "_"));
}

/**
 * Cypher statements, in order, that migrate a graph written by `neo4j-better-auth` for the
 * same Better Auth configuration. Run them once, then create the new constraints with
 * `cyphra migrate deploy` (or `cyphra db push`). Every statement is idempotent.
 *
 * Steps: drop the old constraints and indexes, relabel nodes, rebuild the `HAS_*` edges from the
 * foreign-key properties and remove those properties, convert ISO date strings to `datetime()`
 * and float numbers to integers.
 *
 * @param options - Your Better Auth options (plugins included).
 * @param naming - Must match the `usePlural` you used with neo4j-better-auth, and the
 *   `numberFields` you pass to `cyphraAdapter` (`float` fields are not converted to integers).
 */
export function neo4jBetterAuthMigration(
  options: BetterAuthOptions,
  naming: AuthSchemaOptions = {},
): string[] {
  const graph = authSchema(options, naming);
  const models = [...graph.models.values()];
  const byKey = (key: string) => graph.models.get(key)!;
  const out: string[] = [];

  // 1. Old constraints and indexes (they target the old labels).
  for (const m of models) {
    out.push(`DROP CONSTRAINT ${legacyObjectName(m.dbName, "id_unique")} IF EXISTS`);
    for (const f of m.fields.values()) {
      if (f.name === m.idField) continue;
      if (f.unique)
        out.push(`DROP CONSTRAINT ${legacyObjectName(m.dbName, f.name, "unique")} IF EXISTS`);
      else if (f.index)
        out.push(`DROP INDEX ${legacyObjectName(m.dbName, f.name, "idx")} IF EXISTS`);
    }
  }

  // 2. Labels.
  for (const m of models) {
    if (m.dbName === m.node) continue;
    out.push(`MATCH (n:${quote(m.dbName)}) SET n:${quote(m.node)} REMOVE n:${quote(m.dbName)}`);
  }

  // 3. Edges from the foreign-key properties, then the old edge types that changed name.
  const removeOld: string[] = [];
  for (const m of models) {
    const child = quote(m.node);
    for (const fk of m.foreignKeys) {
      const parent = byKey(fk.parentKey);
      const prop = `c.${quote(fk.name)}`;
      out.push(
        `MATCH (c:${child}) WHERE ${prop} IS NOT NULL ` +
          `MATCH (p:${quote(parent.node)}) WHERE p.${quote(fk.refField)} = ${prop} ` +
          `MERGE (p)-[:${quote(fk.relType)}]->(c)`,
      );
      const oldType = legacyEdgeType(m.dbName);
      const newTypes = m.foreignKeys
        .filter((other) => other.parentKey === fk.parentKey)
        .map((other) => other.relType);
      if (!newTypes.includes(oldType)) {
        removeOld.push(
          `MATCH (:${quote(parent.node)})-[r:${quote(oldType)}]->(:${child}) DELETE r`,
        );
      }
    }
  }
  out.push(...new Set(removeOld));
  for (const m of models) {
    for (const fk of m.foreignKeys) {
      out.push(
        `MATCH (c:${quote(m.node)}) WHERE c.${quote(fk.name)} IS NOT NULL REMOVE c.${quote(fk.name)}`,
      );
    }
  }

  // 4. Value types.
  for (const m of models) {
    for (const f of m.fields.values()) {
      if (f.kind !== "scalar") continue;
      const p = `n.${quote(f.name)}`;
      const match = `MATCH (n:${quote(m.node)})`;
      if (f.type === "DateTime" && !f.list) {
        // toString(x) = x only holds for strings, so converted values are left alone.
        out.push(`${match} WHERE toString(${p}) = ${p} SET ${p} = datetime(${p})`);
      } else if (f.type === "Int" && !f.list) {
        out.push(`${match} WHERE ${p} IS NOT NULL SET ${p} = toInteger(${p})`);
      } else if (f.type === "Int" && f.list) {
        out.push(`${match} WHERE ${p} IS NOT NULL SET ${p} = [x IN ${p} | toInteger(x)]`);
      }
    }
  }
  return out;
}
