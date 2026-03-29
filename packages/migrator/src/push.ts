import type { NodeDeclaration, SchemaDocument } from "@cyphra/schema";

function isScalarWithDecorator(
  field: NodeDeclaration["fields"][number],
  dec: string,
): field is import("@cyphra/schema").ScalarNodeField {
  return field.kind === "Scalar" && field.decorators.some((d) => d.name === dec);
}

function idPropertyName(node: NodeDeclaration): string | undefined {
  for (const f of node.fields) {
    if (isScalarWithDecorator(f, "id")) {
      return f.name;
    }
  }
  return undefined;
}

/**
 * Generate `CREATE CONSTRAINT … IF NOT EXISTS` statements for `@id` and `@unique` scalar fields.
 *
 * @param doc - Parsed schema AST.
 * @returns Cypher DDL strings (Neo4j 5 syntax).
 */
export function constraintStatementsFromSchema(doc: SchemaDocument): string[] {
  const statements: string[] = [];
  for (const decl of doc.declarations) {
    if (decl.kind !== "Node") {
      continue;
    }
    const label = decl.name;
    const idProp = idPropertyName(decl);
    if (idProp) {
      statements.push(
        `CREATE CONSTRAINT ${escapeConstraintName(`${label}_${idProp}_id`)} IF NOT EXISTS FOR (n:\`${label}\`) REQUIRE n.\`${idProp}\` IS UNIQUE`,
      );
    }
    for (const f of decl.fields) {
      if (!isScalarWithDecorator(f, "unique")) {
        continue;
      }
      if (f.name === idProp) {
        continue;
      }
      statements.push(
        `CREATE CONSTRAINT ${escapeConstraintName(`${label}_${f.name}_unique`)} IF NOT EXISTS FOR (n:\`${label}\`) REQUIRE n.\`${f.name}\` IS UNIQUE`,
      );
    }
  }
  return statements;
}

/**
 * Generate `CREATE RANGE INDEX … IF NOT EXISTS` for node scalar fields marked `@index`.
 * Skips properties already covered by {@link constraintStatementsFromSchema} rules.
 *
 * @param doc - Parsed schema AST.
 * @returns Cypher DDL strings (Neo4j 5+ range index syntax).
 */
export function indexStatementsFromSchema(doc: SchemaDocument): string[] {
  const statements: string[] = [];
  for (const decl of doc.declarations) {
    if (decl.kind !== "Node") {
      continue;
    }
    const label = decl.name;
    for (const f of decl.fields) {
      if (f.kind !== "Scalar" || !isScalarWithDecorator(f, "index")) {
        continue;
      }
      statements.push(
        `CREATE RANGE INDEX ${escapeConstraintName(`${label}_${f.name}_idx`)} IF NOT EXISTS FOR (n:\`${label}\`) ON (n.\`${f.name}\`)`,
      );
    }
  }
  return statements;
}

function escapeConstraintName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}
