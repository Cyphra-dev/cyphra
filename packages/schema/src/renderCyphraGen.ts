import type { Decorator, ScalarTypeName, SchemaDocument } from "./ast.js";
import {
  resolveSchema,
  type ResolvedRelationField,
  type ResolvedScalarField,
  type SchemaModel,
} from "./model.js";

/** Options for {@link renderCyphraGenSource}. */
export type RenderCyphraGenOptions = {
  /**
   * Module the generated client imports its runtime from (default `"cyphra"`).
   * Use `"@cyphra/runtime"` if you depend on the runtime package directly.
   */
  readonly runtimeImport?: string;
};

const TS_SCALAR: Record<ScalarTypeName, string> = {
  String: "string",
  Int: "number",
  Float: "number",
  Boolean: "boolean",
  DateTime: "Date",
  Date: "Date",
  BigInt: "bigint",
  Json: "JsonValue",
  Vector: "number[]",
  Enum: "string",
};

function tsFieldType(f: ResolvedScalarField): string {
  const base = f.type === "Enum" && f.enum ? f.enum : TS_SCALAR[f.type];
  if (f.list) return `${base}[]`;
  return f.optional ? `${base} | null` : base;
}

function union(names: readonly string[]): string {
  return names.length ? names.map((n) => JSON.stringify(n)).join(" | ") : "never";
}

function renderObjectType(
  name: string,
  fields: readonly ResolvedScalarField[],
  doc: string,
): string[] {
  const lines = [`/** ${doc} */`, `export type ${name} = {`];
  for (const f of fields) lines.push(`  ${f.name}: ${tsFieldType(f)};`);
  lines.push("};", "");
  return lines;
}

/** Render the typed ORM section (model types, type map, schema model, `createClient`). */
export function renderClientSection(model: SchemaModel): string[] {
  const lines: string[] = [];
  for (const e of model.enums ?? []) {
    lines.push(`/** \`${e.name}\` enum values (\`${e.name}.${e.values[0]}\`, …). */`);
    lines.push(`export const ${e.name} = {`);
    for (const v of e.values) lines.push(`  ${v}: ${JSON.stringify(v)},`);
    lines.push("} as const;", "");
    lines.push(`/** One of the \`${e.name}\` enum values. */`);
    lines.push(`export type ${e.name} = (typeof ${e.name})[keyof typeof ${e.name}];`, "");
  }
  for (const n of model.nodes) {
    const scalars = n.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
    lines.push(...renderObjectType(n.name, scalars, `\`${n.name}\` node properties.`));
  }
  for (const r of model.relationships) {
    lines.push(
      ...renderObjectType(
        r.name,
        r.properties,
        `\`${r.name}\` (\`:${r.relType}\`) edge properties.`,
      ),
    );
  }

  lines.push("/** Type-level description of the schema, consumed by the ORM client. */");
  lines.push("export type CyphraTypeMap = {");
  for (const n of model.nodes) {
    const scalars = n.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
    const required = scalars.filter((f) => !f.optional && !f.list && !f.default).map((f) => f.name);
    lines.push(`  ${n.name}: {`);
    lines.push(`    scalars: ${n.name};`);
    lines.push(`    createRequired: ${union(required)};`);
    lines.push(`    unique: ${union(n.uniqueFields)};`);
    // Only emitted when present, so schemas without vectors generate the same code as before.
    const vectors = scalars.filter((f) => f.type === "Vector");
    if (vectors.length > 0) {
      lines.push(`    vectors: ${union(vectors.map((f) => f.name))};`);
      lines.push(
        `    vectorIndexes: ${union(vectors.filter((f) => f.vectorIndex).map((f) => f.name))};`,
      );
    }
    if (n.fulltextIndexes?.length) {
      lines.push(`    fulltextIndexes: ${union(n.fulltextIndexes.map((i) => i.name))};`);
    }
    const relations = n.fields.filter((f): f is ResolvedRelationField => f.kind === "relation");
    if (relations.length === 0) {
      // Not `{}`: an empty object type trips @typescript-eslint/no-empty-object-type.
      lines.push("    relations: Record<never, never>;");
    } else {
      lines.push("    relations: {");
      for (const f of relations) {
        lines.push(
          `      ${f.name}: { target: ${JSON.stringify(f.target)}; many: ${f.many}; optional: ${f.optional}; edge: ${f.edge ?? "null"} };`,
        );
      }
      lines.push("    };");
    }
    lines.push("  };");
  }
  lines.push("};", "");

  lines.push("/** Resolved schema model embedded for the runtime. */");
  lines.push(`export const schemaModel: SchemaModel = ${JSON.stringify(model, null, 2)};`, "");

  lines.push("/** Typed Cyphra client for this schema. */");
  lines.push("export type Db = OrmClient<CyphraTypeMap>;", "");
  lines.push("/**");
  lines.push(
    " * Create a typed client: `db.user.findMany(...)`, `db.post.create(...)`, `db.$transaction(...)`.",
  );
  lines.push(" *");
  lines.push(
    " * @param options - Connection options (`uri`, `user`, `password`, …) or `{ client }`.",
  );
  lines.push(" */");
  lines.push("export function createClient(options: OrmOptions): Db {");
  lines.push("  return createOrm<CyphraTypeMap>(schemaModel, options);");
  lines.push("}", "");
  return lines;
}

function decoratorStringArg(
  decorators: readonly Decorator[],
  decoratorName: string,
  argKey: string,
): string | undefined {
  const dec = decorators.find((d) => d.name === decoratorName);
  if (!dec) {
    return undefined;
  }
  const arg = dec.args.find((a) => a.key === argKey);
  if (!arg || arg.value.kind !== "string") {
    return undefined;
  }
  return arg.value.value;
}

/** Data used to emit `cyphra.gen.ts`. */
export type CodegenModel = {
  readonly nodeLabels: readonly string[];
  readonly relationshipModels: readonly {
    readonly name: string;
    readonly neo4jType: string;
    readonly fromLabel: string;
    readonly toLabel: string;
  }[];
  readonly relNeo4jTypes: readonly string[];
};

/**
 * Walk the AST and collect labels, relationship models, and all Neo4j relationship types.
 *
 * @param doc - Validated schema document.
 */
export function collectCodegenModel(doc: SchemaDocument): CodegenModel {
  const nodeLabels: string[] = [];
  const relationshipModels: {
    name: string;
    neo4jType: string;
    fromLabel: string;
    toLabel: string;
  }[] = [];
  const relTypes = new Set<string>();

  for (const decl of doc.declarations) {
    if (decl.kind === "Enum") continue;
    if (decl.kind === "Node") {
      nodeLabels.push(decl.name);
      for (const f of decl.fields) {
        if (f.kind === "Relational") {
          const t = decoratorStringArg(f.decorators, "relationship", "type");
          if (t) {
            relTypes.add(t);
          }
        }
      }
    } else {
      relationshipModels.push({
        name: decl.name,
        neo4jType: decl.relType,
        fromLabel: decl.from,
        toLabel: decl.to,
      });
      relTypes.add(decl.relType);
    }
  }

  return {
    nodeLabels,
    relationshipModels,
    relNeo4jTypes: [...relTypes].sort(),
  };
}

/**
 * Turn a Neo4j relationship type string into a stable `RelType` object key (valid identifier).
 *
 * @param type - Value inside `type: "…"` in the schema.
 */
export function relTypeToExportKey(type: string, used: Set<string>): string {
  let base = type.replace(/[^A-Za-z0-9_]/g, "_");
  if (!base || /^[0-9]/.test(base)) {
    base = `T_${base || "rel"}`;
  }
  let key = base;
  let n = 2;
  while (used.has(key)) {
    key = `${base}_${n++}`;
  }
  used.add(key);
  return key;
}

/**
 * Render a `cyphra.gen.ts` module for use with the query builder and migrations.
 *
 * @param doc - Parsed and validated schema.
 */
export function renderCyphraGenSource(
  doc: SchemaDocument,
  options: RenderCyphraGenOptions = {},
): string {
  const resolved = resolveSchema(doc);
  const runtimeImport = options.runtimeImport ?? "cyphra";
  const model = collectCodegenModel(doc);
  const lines: string[] = [];

  lines.push("/**");
  lines.push(" * Generated by `cyphra generate` — do not edit by hand.");
  lines.push(" */");
  lines.push("");
  // `JsonValue` is only imported when a field uses it, so other schemas generate the same code.
  const usesJson = [
    ...resolved.nodes.flatMap((n) => n.fields),
    ...resolved.relationships.flatMap((r) => r.properties),
  ].some((f) => f.kind === "scalar" && f.type === "Json");
  lines.push(
    `import { createOrm, ${usesJson ? "type JsonValue, " : ""}type OrmClient, type OrmOptions, type SchemaModel } from ${JSON.stringify(runtimeImport)};`,
  );
  lines.push("");
  lines.push("/** Neo4j node labels from `node` declarations. */");
  lines.push("export const NodeLabel = {");
  for (const L of model.nodeLabels) {
    lines.push(`  ${L}: ${JSON.stringify(L)},`);
  }
  lines.push("} as const;");
  lines.push("");
  lines.push("export type NodeLabelName = keyof typeof NodeLabel;");
  lines.push("");

  lines.push("/** Rich `relationship { … }` blocks: Neo4j type + endpoint labels. */");
  lines.push("export const RelationshipSpec = {");
  for (const r of model.relationshipModels) {
    lines.push(`  ${r.name}: {`);
    lines.push(`    neo4jType: ${JSON.stringify(r.neo4jType)},`);
    lines.push(`    fromLabel: ${JSON.stringify(r.fromLabel)},`);
    lines.push(`    toLabel: ${JSON.stringify(r.toLabel)},`);
    lines.push(`  },`);
  }
  lines.push("} as const;");
  lines.push("");
  lines.push("export type RelationshipModelName = keyof typeof RelationshipSpec;");
  lines.push("");

  lines.push("/** Distinct Neo4j relationship types used on fields or declarations. */");
  lines.push("export const RelType = {");
  const usedKeys = new Set<string>();
  for (const t of model.relNeo4jTypes) {
    const key = relTypeToExportKey(t, usedKeys);
    lines.push(`  ${key}: ${JSON.stringify(t)},`);
  }
  lines.push("} as const;");
  lines.push("");
  lines.push("export type RelTypeKey = keyof typeof RelType;");
  lines.push("");

  lines.push(...renderClientSection(resolved));
  return lines.join("\n");
}
