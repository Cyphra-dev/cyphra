import {
  resolveSchema,
  type NodeDeclaration,
  type ScalarNodeField,
  type SchemaDocument,
} from "@cyphra/schema";
import { fulltextIndexStatement, vectorIndexStatement } from "./diff.js";

function isScalarWithDecorator(
  field: { readonly kind: string; readonly decorators: readonly { readonly name: string }[] },
  dec: string,
): field is ScalarNodeField {
  return field.kind === "Scalar" && field.decorators.some((d) => d.name === dec);
}

/** Decorator presence without a type predicate (avoids `never` when chaining multiple `@…` checks). */
function hasDecoratorName(
  field: { readonly decorators: readonly { readonly name: string }[] },
  name: string,
): boolean {
  return field.decorators.some((d) => d.name === name);
}

/** Cypher relationship type token for patterns (`:KNOWS` or :`a-b`). */
function cypherRelTypeToken(relType: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(relType)) {
    return relType;
  }
  return `\`${relType.replace(/`/g, "``")}\``;
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
 * Generate `CREATE CONSTRAINT … IF NOT EXISTS` statements for node `@id` / `@unique` and relationship `@unique`.
 *
 * Relationship property uniqueness uses Neo4j 5.7+ syntax (`FOR ()-[r:TYPE]-() REQUIRE r.prop IS UNIQUE`).
 *
 * @param doc - Parsed schema AST.
 * @returns Cypher DDL strings (Neo4j 5 syntax).
 */
export function constraintStatementsFromSchema(doc: SchemaDocument): string[] {
  const statements: string[] = [];
  for (const decl of doc.declarations) {
    if (decl.kind === "Node") {
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
      continue;
    }
    if (decl.kind === "Enum") continue;

    const typeTok = cypherRelTypeToken(decl.relType);
    for (const f of decl.fields) {
      if (!isScalarWithDecorator(f, "unique")) {
        continue;
      }
      statements.push(
        `CREATE CONSTRAINT ${escapeConstraintName(`${decl.name}_${f.name}_rel_unique`)} IF NOT EXISTS FOR ()-[r:${typeTok}]-() REQUIRE r.\`${f.name}\` IS UNIQUE`,
      );
    }
  }
  return statements;
}

/**
 * Generate `CREATE RANGE INDEX … IF NOT EXISTS` for `@index` on **node** scalars and on **relationship** model scalars.
 * Node indexes use `(n:Label)`; relationship indexes use `()-[r:TYPE]-()` with the Neo4j type from `type "…"`.
 *
 * @param doc - Parsed schema AST.
 * @returns Cypher DDL strings (Neo4j 5+ range index syntax).
 */
export function indexStatementsFromSchema(doc: SchemaDocument): string[] {
  const statements: string[] = [];
  for (const decl of doc.declarations) {
    if (decl.kind === "Node") {
      const label = decl.name;
      for (const f of decl.fields) {
        if (f.kind !== "Scalar") {
          continue;
        }
        if (!isScalarWithDecorator(f, "index")) {
          continue;
        }
        if (hasDecoratorName(f, "unique")) {
          continue;
        }
        statements.push(
          `CREATE RANGE INDEX ${escapeConstraintName(`${label}_${f.name}_idx`)} IF NOT EXISTS FOR (n:\`${label}\`) ON (n.\`${f.name}\`)`,
        );
      }
      continue;
    }
    if (decl.kind === "Enum") continue;

    const typeTok = cypherRelTypeToken(decl.relType);
    for (const f of decl.fields) {
      if (!isScalarWithDecorator(f, "index")) {
        continue;
      }
      if (hasDecoratorName(f, "unique")) {
        continue;
      }
      statements.push(
        `CREATE RANGE INDEX ${escapeConstraintName(`${decl.name}_${f.name}_rel_idx`)} IF NOT EXISTS FOR ()-[r:${typeTok}]-() ON (r.\`${f.name}\`)`,
      );
    }
  }
  return statements;
}

/**
 * Generate `CREATE VECTOR INDEX … IF NOT EXISTS` for every `Vector(N) @vectorIndex(...)` node field,
 * with `vector.dimensions` and `vector.similarity_function` in `OPTIONS` (Neo4j 5.15+).
 *
 * @param doc - Parsed schema AST.
 * @returns Cypher DDL strings, named like migrations name them.
 */
export function vectorIndexStatementsFromSchema(doc: SchemaDocument): string[] {
  const statements: string[] = [];
  for (const n of resolveSchema(doc).nodes) {
    for (const f of n.fields) {
      const stmt = f.kind === "scalar" ? vectorIndexStatement(n.label, f) : null;
      if (stmt) statements.push(stmt);
    }
  }
  return statements;
}

/**
 * Generate `CREATE FULLTEXT INDEX … IF NOT EXISTS` for every `@@fulltext([...])` node attribute,
 * with `fulltext.analyzer` / `fulltext.eventually_consistent` in `OPTIONS` when set.
 *
 * @param doc - Parsed schema AST.
 * @returns Cypher DDL strings, named like migrations name them.
 */
export function fulltextIndexStatementsFromSchema(doc: SchemaDocument): string[] {
  const statements: string[] = [];
  for (const n of resolveSchema(doc).nodes) {
    for (const index of n.fulltextIndexes ?? []) {
      statements.push(fulltextIndexStatement(n.label, index));
    }
  }
  return statements;
}

function escapeConstraintName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}
