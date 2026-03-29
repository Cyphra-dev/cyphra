import type { SchemaDocument } from "@cyphra/schema";

/**
 * Static hints for operating a database alongside the schema (no live DB inspection in V1).
 *
 * @param doc - Parsed schema document.
 * @returns Human-readable lines suitable for logs or docs.
 */
export function schemaIntegrationHints(doc: SchemaDocument): string[] {
  const hints: string[] = [];
  for (const d of doc.declarations) {
    if (d.kind === "Relationship") {
      hints.push(
        `Relationship model "${d.name}" maps to Neo4j type \`${d.relType}\` (:${d.from} → :${d.to}).`,
      );
    }
  }
  return hints;
}
