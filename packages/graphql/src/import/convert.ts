/**
 * Convert `@neo4j/graphql` v7 type definitions (SDL) to a Cyphra {@link SchemaDocument}.
 *
 * Pure: no file system, no printing. Rules for each scalar and directive live in `mappings.ts`;
 * this module walks the SDL, applies them and links relationships.
 *
 * @packageDocumentation
 */

import {
  GraphQLError,
  Kind,
  parse,
  print,
  type ConstDirectiveNode,
  type DefinitionNode,
  type FieldDefinitionNode,
  type TypeNode,
} from "graphql";
import type {
  Decorator,
  EnumDeclaration,
  ModelAttribute,
  NodeDeclaration,
  NodeField,
  RelationshipDeclaration,
  ScalarNodeField,
  SchemaDocument,
  UnionDeclaration,
} from "@cyphra/schema";
import {
  CUSTOM_SCALAR_FIELD,
  CYPHRA_TYPE_NAMES,
  ENUM_AS_STRING,
  FIELD_DIRECTIVES,
  RELATIONSHIP_API_ARGS,
  SCALARS,
  TYPE_DIRECTIVES,
  UNION_EDGE_PROPERTIES,
  convertUnion,
  enumField,
  enumListArg,
  stringArg,
  type FulltextDraft,
  type ImportIssue,
  type IssueDraft,
  type ScalarMapping,
} from "./mappings.js";

/** One type definitions file. */
export type GraphQLSource = { readonly name: string; readonly body: string };

export type GraphQLImportResult = {
  readonly document: SchemaDocument;
  /** Everything that was not converted or behaves differently, in source order. */
  readonly issues: readonly ImportIssue[];
  /**
   * Comment lines to print inside a declaration (keyed by Cyphra declaration name), one per
   * field that was not converted.
   */
  readonly notes: ReadonlyMap<string, readonly string[]>;
};

/** The type definitions are not valid GraphQL (syntax error, unknown type, duplicate type). */
export class GraphQLImportError extends Error {
  override name = "GraphQLImportError";
}

type TypeKind = "object" | "interface" | "union" | "enum" | "scalar" | "input";

type TypeInfo = {
  readonly name: string;
  readonly kind: TypeKind;
  readonly directives: ConstDirectiveNode[];
  readonly fields: FieldDefinitionNode[];
  /** Values of an enum type. */
  readonly values: string[];
  /** Member types of a union. */
  readonly members: string[];
  readonly source: string;
};

type Unwrapped = { named: string; list: boolean; nonNull: boolean; nested: boolean };

const ROOT_TYPES = new Set(["Query", "Mutation", "Subscription"]);

function unwrap(t: TypeNode): Unwrapped {
  let nonNull = false;
  let list = false;
  let nested = false;
  let cur = t;
  if (cur.kind === Kind.NON_NULL_TYPE) {
    nonNull = true;
    cur = cur.type;
  }
  if (cur.kind === Kind.LIST_TYPE) {
    list = true;
    cur = cur.type.kind === Kind.NON_NULL_TYPE ? cur.type.type : cur.type;
    if (cur.kind === Kind.LIST_TYPE) nested = true;
  }
  while (cur.kind !== Kind.NAMED_TYPE) cur = cur.type;
  return { named: cur.name.value, list, nonNull, nested };
}

function directive(
  dirs: readonly ConstDirectiveNode[] | undefined,
  name: string,
): ConstDirectiveNode | undefined {
  return dirs?.find((d) => d.name.value === name);
}

function kindOf(def: DefinitionNode): { kind: TypeKind; extension: boolean } | undefined {
  switch (def.kind) {
    case Kind.OBJECT_TYPE_DEFINITION:
      return { kind: "object", extension: false };
    case Kind.OBJECT_TYPE_EXTENSION:
      return { kind: "object", extension: true };
    case Kind.INTERFACE_TYPE_DEFINITION:
      return { kind: "interface", extension: false };
    case Kind.INTERFACE_TYPE_EXTENSION:
      return { kind: "interface", extension: true };
    case Kind.UNION_TYPE_DEFINITION:
      return { kind: "union", extension: false };
    case Kind.UNION_TYPE_EXTENSION:
      return { kind: "union", extension: true };
    case Kind.ENUM_TYPE_DEFINITION:
      return { kind: "enum", extension: false };
    case Kind.ENUM_TYPE_EXTENSION:
      return { kind: "enum", extension: true };
    case Kind.SCALAR_TYPE_DEFINITION:
      return { kind: "scalar", extension: false };
    case Kind.SCALAR_TYPE_EXTENSION:
      return { kind: "scalar", extension: true };
    case Kind.INPUT_OBJECT_TYPE_DEFINITION:
      return { kind: "input", extension: false };
    case Kind.INPUT_OBJECT_TYPE_EXTENSION:
      return { kind: "input", extension: true };
    default:
      return undefined;
  }
}

/** Directives of a type system definition (they are always constant there). */
function directivesOf(def: DefinitionNode): readonly ConstDirectiveNode[] {
  return ("directives" in def && (def.directives as readonly ConstDirectiveNode[])) || [];
}

/** Parse every source and merge `extend type` blocks into their definitions. */
function collectTypes(sources: readonly GraphQLSource[]): Map<string, TypeInfo> {
  const types = new Map<string, TypeInfo>();
  const extensions: { name: string; def: DefinitionNode; source: string }[] = [];
  for (const src of sources) {
    let doc;
    try {
      doc = parse(src.body);
    } catch (err) {
      if (err instanceof GraphQLError) {
        const loc = err.locations?.[0];
        const where = loc ? `${src.name}:${loc.line}:${loc.column}` : src.name;
        throw new GraphQLImportError(`${where}: ${err.message}`);
      }
      throw err;
    }
    for (const def of doc.definitions) {
      const k = kindOf(def);
      if (!k || !("name" in def) || !def.name) continue;
      const name = def.name.value;
      if (k.extension) {
        extensions.push({ name, def, source: src.name });
        continue;
      }
      // Redeclaring a built-in scalar (`scalar DateTime`) is harmless.
      if (k.kind === "scalar" && SCALARS[name]) continue;
      if (types.has(name) || SCALARS[name]) {
        throw new GraphQLImportError(`${src.name}: type "${name}" is defined more than once.`);
      }
      types.set(name, {
        name,
        kind: k.kind,
        directives: [...directivesOf(def)],
        fields: [
          ...((def.kind === Kind.OBJECT_TYPE_DEFINITION ||
          def.kind === Kind.INTERFACE_TYPE_DEFINITION
            ? def.fields
            : undefined) ?? []),
        ],
        values: [
          ...((def.kind === Kind.ENUM_TYPE_DEFINITION ? def.values : undefined) ?? []).map(
            (v) => v.name.value,
          ),
        ],
        members: [
          ...((def.kind === Kind.UNION_TYPE_DEFINITION ? def.types : undefined) ?? []).map(
            (m) => m.name.value,
          ),
        ],
        source: src.name,
      });
    }
  }
  for (const ext of extensions) {
    const base = types.get(ext.name);
    if (!base) {
      throw new GraphQLImportError(`${ext.source}: cannot extend unknown type "${ext.name}".`);
    }
    const def = ext.def;
    base.directives.push(...directivesOf(def));
    if (
      (def.kind === Kind.OBJECT_TYPE_EXTENSION || def.kind === Kind.INTERFACE_TYPE_EXTENSION) &&
      def.fields
    ) {
      base.fields.push(...def.fields);
    }
    if (def.kind === Kind.ENUM_TYPE_EXTENSION && def.values) {
      base.values.push(...def.values.map((v) => v.name.value));
    }
    if (def.kind === Kind.UNION_TYPE_EXTENSION && def.types) {
      base.members.push(...def.types.map((m) => m.name.value));
    }
  }
  return types;
}

/**
 * Every field must reference a type that exists (built-in, `@neo4j/graphql` or declared), and every
 * union member must be an object type.
 */
function checkReferences(types: Map<string, TypeInfo>): void {
  for (const t of types.values()) {
    if (t.kind === "union") {
      for (const m of t.members) {
        const member = types.get(m);
        if (!member || member.kind !== "object") {
          throw new GraphQLImportError(
            `${t.source}: union "${t.name}" can only include object types, not "${m}".`,
          );
        }
      }
    }
    if (t.kind !== "object" && t.kind !== "interface") continue;
    for (const f of t.fields) {
      const { named } = unwrap(f.type);
      if (!types.has(named) && !SCALARS[named]) {
        throw new GraphQLImportError(
          `${t.source}: field "${t.name}.${f.name.value}" has unknown type "${named}".`,
        );
      }
    }
  }
}

type RelUsage = {
  readonly propsType: string;
  readonly relType: string;
  readonly start: string;
  readonly end: string;
  readonly at: string;
};

/**
 * Convert type definitions to a Cyphra schema document plus a report of what was not
 * converted. Never throws for unsupported features; only for invalid SDL.
 *
 * @param input - SDL text, or several named sources (merged like one document).
 * @throws {GraphQLImportError} On a syntax error, an unknown type or a duplicate type.
 */
export function convertGraphQLTypeDefs(
  input: string | readonly GraphQLSource[],
): GraphQLImportResult {
  const sources = typeof input === "string" ? [{ name: "typeDefs", body: input }] : input;
  const types = collectTypes(sources);
  checkReferences(types);

  const issues: ImportIssue[] = [];
  const report = (at: string, d: IssueDraft) => issues.push({ at, ...d });
  const notes = new Map<string, string[]>();
  const note = (decl: string, line: string) => {
    const list = notes.get(decl) ?? [];
    list.push(line);
    notes.set(decl, list);
  };

  // Pass 1: classify types and pick Cyphra node names.
  const nodeTypes: TypeInfo[] = [];
  const propsTypes = new Map<string, TypeInfo>();
  const nodeName = new Map<string, string>();
  for (const t of types.values()) {
    if (t.kind === "object" && directive(t.directives, "node")) {
      nodeTypes.push(t);
      continue;
    }
    if (t.kind === "object" && directive(t.directives, "relationshipProperties")) {
      propsTypes.set(t.name, t);
      continue;
    }
    switch (t.kind) {
      case "enum":
        // Converted to a Cyphra `enum` when a converted field uses it (see `enumMappings`).
        break;
      case "interface":
        report(t.name, {
          severity: "unsupported",
          feature: "interface",
          message:
            "@neo4j/graphql interfaces are not labels (Cyphra interfaces are): implementing @node types are converted with their own fields, relationships to the interface are not; to share a label, declare a Cyphra `interface`, implement it and backfill the label",
        });
        break;
      case "union":
        // Converted once the member nodes have their Cyphra names (below).
        break;
      case "scalar":
        report(t.name, {
          severity: "unsupported",
          feature: "scalar",
          message:
            "custom scalars are not supported by Cyphra: fields of this type are not converted",
        });
        break;
      case "input":
        report(t.name, {
          severity: "ignored",
          feature: "input",
          message: "input types are part of the GraphQL API, not the data model",
        });
        break;
      case "object":
        if (ROOT_TYPES.has(t.name)) {
          report(t.name, {
            severity: "unsupported",
            feature: t.name,
            message: `custom ${t.name} fields (@cypher, resolvers) are not converted (compat.v7 still serves @cypher fields); with the typed client, write them as queries`,
          });
        } else if (directive(t.directives, "jwt")) {
          report(t.name, {
            severity: "ignored",
            feature: "@jwt",
            message: "JWT payload type, used by authorization rules only",
          });
        } else {
          report(t.name, {
            severity: "unsupported",
            feature: "@node",
            message:
              "object type without @node is not a node in v7 (e.g. a @cypher result type): not converted",
          });
        }
        break;
    }
  }

  const usedNames = new Set<string>(types.keys());
  const fulltextOf = new Map<string, FulltextDraft[]>();
  for (const t of nodeTypes) {
    let name = t.name;
    for (const d of t.directives) {
      const n = d.name.value;
      if (n === "relationshipProperties") {
        report(t.name, {
          severity: "unsupported",
          feature: "@relationshipProperties",
          message: "a type cannot be both @node and @relationshipProperties: kept as a node",
        });
        continue;
      }
      const rule = TYPE_DIRECTIVES[n];
      if (!rule) {
        report(t.name, {
          severity: "unsupported",
          feature: `@${n}`,
          message: `unknown directive @${n}: not converted`,
        });
        continue;
      }
      const effect = rule(d, t.name);
      for (const i of effect.issues ?? []) report(t.name, i);
      if (effect.fulltext?.length) {
        fulltextOf.set(t.name, [...(fulltextOf.get(t.name) ?? []), ...effect.fulltext]);
      }
      if (effect.rename && effect.rename !== name) {
        if (usedNames.has(effect.rename) || [...nodeName.values()].includes(effect.rename)) {
          report(t.name, {
            severity: "unsupported",
            feature: "@node(labels)",
            message: `cannot rename to "${effect.rename}": the name is taken; kept "${t.name}"`,
          });
        } else {
          name = effect.rename;
        }
      }
    }
    nodeName.set(t.name, name);
  }

  // Unions: a Cyphra `union` of the member nodes (no label, like v7).
  const unions: UnionDeclaration[] = [];
  const unionNames = new Set<string>();
  for (const t of types.values()) {
    if (t.kind !== "union") continue;
    const effect = convertUnion(
      t.name,
      t.members.map((m) => ({ graphqlName: m, node: nodeName.get(m) })),
      t.directives,
    );
    for (const i of effect.issues) report(t.name, i);
    if (!effect.members) continue;
    unions.push({ kind: "Union", name: t.name, members: [...effect.members] });
    unionNames.add(t.name);
  }

  // Enums: a Cyphra `enum` per GraphQL enum, unless its name is taken.
  const enumMap = enumMappings(types, new Set(nodeName.values()), report);
  const usedEnums = new Set<string>();
  const mapScalar = (named: string): ScalarMapping & { isEnum?: boolean } => {
    const m = scalarMapping(named, types, enumMap);
    if ("enum" in m && m.enum) usedEnums.add(m.enum);
    return m;
  };

  // Pass 2: fields.
  const usages: RelUsage[] = [];
  const declarations: NodeDeclaration[] = [];
  for (const t of nodeTypes) {
    const declName = nodeName.get(t.name)!;
    const fields: NodeField[] = [];
    /** GraphQL field name → converted scalar field (its name may differ after `@alias`). */
    const scalarOf = new Map<string, ScalarNodeField>();
    let hasId = false;
    for (const f of t.fields) {
      const at = `${t.name}.${f.name.value}`;
      const u = unwrap(f.type);
      const target = types.get(u.named);
      const isRelation =
        Boolean(directive(f.directives, "relationship")) ||
        (target !== undefined &&
          (target.kind === "object" || target.kind === "interface" || target.kind === "union"));
      if (dropComputed(f, at, report)) {
        note(declName, skippedLine(f, "computed field"));
        continue;
      }
      if (isRelation) {
        const rel = convertRelation(f, u, at, t.name, types, nodeName, unionNames, report);
        if (!rel) {
          note(declName, skippedLine(f, "relationship not converted"));
          continue;
        }
        fields.push(rel.field);
        if (rel.usage) usages.push(rel.usage);
        continue;
      }
      const scalar = convertScalar(f, u, at, "node", hasId, mapScalar, report);
      if (!scalar) {
        note(declName, skippedLine(f, "type not supported"));
        continue;
      }
      if (scalar.takesId) hasId = true;
      fields.push(scalar.field);
      scalarOf.set(f.name.value, scalar.field);
    }
    const kept = dedupeNames(fields, t.name, report);
    const attributes = fulltextAttributes(
      t.name,
      fulltextOf.get(t.name) ?? [],
      (name) => {
        const f = scalarOf.get(name);
        return f && kept.includes(f) ? f : undefined;
      },
      report,
    );
    declarations.push({
      kind: "Node",
      name: declName,
      fields: kept,
      ...(attributes.length ? { attributes } : {}),
    });
  }

  // Relationship models: one per (props type, relType, start, end).
  const relationships: RelationshipDeclaration[] = [];
  const takenTriples = new Map<string, string>();
  const allNames = new Set<string>(declarations.map((d) => d.name));
  for (const props of propsTypes.values()) {
    const triples: RelUsage[] = [];
    for (const u of usages.filter((x) => x.propsType === props.name)) {
      const key = `${u.relType}|${u.start}|${u.end}`;
      const owner = takenTriples.get(key);
      if (owner && owner !== props.name) {
        report(u.at, {
          severity: "unsupported",
          feature: "@relationship(properties)",
          message: `${u.relType} from ${u.start} to ${u.end} already has properties "${owner}": "${props.name}" not attached`,
        });
        continue;
      }
      if (!owner) {
        takenTriples.set(key, props.name);
        triples.push(u);
      }
    }
    if (triples.length === 0) {
      report(props.name, {
        severity: "ignored",
        feature: "@relationshipProperties",
        message: "not used by any converted @relationship: not converted",
      });
      continue;
    }
    const scalarFields: ScalarNodeField[] = [];
    const propNotes: string[] = [];
    for (const f of props.fields) {
      const at = `${props.name}.${f.name.value}`;
      if (dropComputed(f, at, report)) {
        propNotes.push(skippedLine(f, "computed field"));
        continue;
      }
      const u = unwrap(f.type);
      const target = types.get(u.named);
      if (
        directive(f.directives, "relationship") ||
        (target &&
          (target.kind === "object" || target.kind === "interface" || target.kind === "union"))
      ) {
        report(at, {
          severity: "unsupported",
          feature: "relationship properties",
          message: "relationship properties can only be scalars: not converted",
        });
        propNotes.push(skippedLine(f, "not a scalar"));
        continue;
      }
      const scalar = convertScalar(f, u, at, "relationship", false, mapScalar, report);
      if (!scalar) {
        propNotes.push(skippedLine(f, "type not supported"));
        continue;
      }
      scalarFields.push(scalar.field);
    }
    const unique = dedupeNames(scalarFields, props.name, report) as ScalarNodeField[];
    for (const u of triples) {
      let name = props.name;
      if (triples.length > 1) {
        name = `${props.name}${u.start}${u.end}`;
        report(props.name, {
          severity: "changed",
          feature: "@relationshipProperties",
          message: `used by several node pairs: written as relationship "${name}" for ${u.relType} from ${u.start} to ${u.end}`,
        });
      }
      let n = 2;
      const base = name;
      while (allNames.has(name)) name = `${base}${n++}`;
      allNames.add(name);
      relationships.push({
        kind: "Relationship",
        name,
        relType: u.relType,
        from: u.start,
        to: u.end,
        fields: unique,
      });
      if (propNotes.length) notes.set(name, [...propNotes]);
    }
  }

  const enums: EnumDeclaration[] = [...types.values()]
    .filter((t) => usedEnums.has(t.name))
    .map((t) => ({ kind: "Enum", name: t.name, values: [...t.values] }));
  return {
    document: {
      kind: "Document",
      declarations: [...enums, ...unions, ...declarations, ...relationships],
    },
    issues,
    notes,
  };
}

/**
 * `@@fulltext([fields], name: "…")` attributes for the `@fulltext` indexes of one type. An index
 * whose fields were not all converted to `String` fields is reported and left out.
 */
function fulltextAttributes(
  typeName: string,
  drafts: readonly FulltextDraft[],
  fieldOf: (graphqlName: string) => ScalarNodeField | undefined,
  report: (at: string, d: IssueDraft) => void,
): ModelAttribute[] {
  const out: ModelAttribute[] = [];
  const names = new Set<string>();
  for (const ix of drafts) {
    if (names.has(ix.name)) {
      report(typeName, {
        severity: "unsupported",
        feature: "@fulltext",
        message: `index "${ix.name}" is declared twice: kept the first`,
      });
      continue;
    }
    const fields: string[] = [];
    let problem: string | undefined;
    for (const name of ix.fields) {
      const f = fieldOf(name);
      if (!f) problem = `field "${name}" was not converted`;
      else if (f.type.name !== "String") problem = `field "${name}" is not a String or ID field`;
      else if (fields.includes(f.name)) problem = `field "${name}" is listed twice`;
      else fields.push(f.name);
      if (problem) break;
    }
    if (problem) {
      report(typeName, {
        severity: "unsupported",
        feature: "@fulltext",
        message: `index "${ix.name}": ${problem}; not converted`,
      });
      continue;
    }
    names.add(ix.name);
    out.push({
      kind: "ModelAttribute",
      name: "fulltext",
      fields,
      args: [{ key: "name", value: { kind: "string", value: ix.name } }],
    });
  }
  return out;
}

function skippedLine(f: FieldDefinitionNode, why: string): string {
  return `${f.name.value}: ${print(f.type)} (not converted: ${why})`;
}

/** Drop `@cypher` / `@customResolver` fields; returns `true` when the field was dropped. */
function dropComputed(
  f: FieldDefinitionNode,
  at: string,
  report: (at: string, d: IssueDraft) => void,
): boolean {
  for (const d of f.directives ?? []) {
    const rule = FIELD_DIRECTIVES[d.name.value];
    if (rule?.kind === "drop") {
      report(at, { severity: "unsupported", feature: `@${d.name.value}`, message: rule.message });
      return true;
    }
  }
  return false;
}

/** Remove fields whose (possibly renamed) name repeats an earlier one. */
function dedupeNames(
  fields: NodeField[],
  typeName: string,
  report: (at: string, d: IssueDraft) => void,
): NodeField[] {
  const seen = new Set<string>();
  const out: NodeField[] = [];
  for (const f of fields) {
    if (seen.has(f.name)) {
      report(`${typeName}.${f.name}`, {
        severity: "unsupported",
        feature: "field name",
        message: `two fields map to the property "${f.name}": kept the first`,
      });
      continue;
    }
    seen.add(f.name);
    out.push(f);
  }
  return out;
}

/** How each GraphQL enum is mapped: a Cyphra enum, or `String` when its name is taken. */
function enumMappings(
  types: Map<string, TypeInfo>,
  nodeNames: ReadonlySet<string>,
  report: (at: string, d: IssueDraft) => void,
): Map<string, ScalarMapping> {
  const out = new Map<string, ScalarMapping>();
  for (const t of types.values()) {
    if (t.kind !== "enum") continue;
    if (CYPHRA_TYPE_NAMES.has(t.name) || nodeNames.has(t.name) || t.values.length === 0) {
      out.set(t.name, ENUM_AS_STRING);
      if ("note" in ENUM_AS_STRING && ENUM_AS_STRING.note) {
        report(t.name, { severity: "changed", feature: "enum", message: ENUM_AS_STRING.note });
      }
      continue;
    }
    out.set(t.name, enumField(t.name));
  }
  return out;
}

function scalarMapping(
  named: string,
  types: Map<string, TypeInfo>,
  enums: ReadonlyMap<string, ScalarMapping>,
): ScalarMapping & { isEnum?: boolean } {
  const builtin = SCALARS[named];
  if (builtin) return builtin;
  const t = types.get(named);
  if (t?.kind === "enum") return { ...(enums.get(named) ?? ENUM_AS_STRING), isEnum: true };
  return CUSTOM_SCALAR_FIELD;
}

const DECORATOR_ORDER = ["id", "unique", "index", "default"];

function convertScalar(
  f: FieldDefinitionNode,
  u: Unwrapped,
  at: string,
  owner: "node" | "relationship",
  nodeHasId: boolean,
  mapScalar: (named: string) => ScalarMapping & { isEnum?: boolean },
  report: (at: string, d: IssueDraft) => void,
): { field: ScalarNodeField; takesId: boolean } | undefined {
  if (u.nested) {
    report(at, {
      severity: "unsupported",
      feature: "nested list",
      message: "lists of lists are not supported: not converted",
    });
    return undefined;
  }
  const mapping = mapScalar(u.named);
  if ("unsupported" in mapping) {
    report(at, {
      severity: "unsupported",
      feature: u.named,
      message: `${mapping.unsupported}: not converted`,
    });
    return undefined;
  }
  let name = f.name.value;
  let optional = !u.nonNull;
  let takesId = false;
  const decorators: Decorator[] = [];
  for (const d of f.directives ?? []) {
    const n = d.name.value;
    if (n === "relationship") continue; // only reaches here on a scalar target: reported below
    const rule = FIELD_DIRECTIVES[n];
    if (!rule) {
      report(at, {
        severity: "unsupported",
        feature: `@${n}`,
        message: `unknown directive @${n}: not converted`,
      });
      continue;
    }
    if (rule.kind === "report") {
      report(at, { severity: rule.severity, feature: `@${n}`, message: rule.message });
      continue;
    }
    if (rule.kind !== "scalar") continue;
    const effect = rule.apply(d, {
      owner,
      graphqlType: u.named,
      type: mapping.type,
      list: u.list,
      isEnum: Boolean(mapping.isEnum),
      nodeHasId: nodeHasId || takesId,
    });
    for (const i of effect.issues ?? []) report(at, i);
    for (const dec of effect.decorators ?? []) {
      if (decorators.some((x) => x.name === dec.name)) {
        report(at, {
          severity: "unsupported",
          feature: `@${n}`,
          message: `conflicts with another directive setting @${dec.name}: kept the first`,
        });
        continue;
      }
      decorators.push(dec);
    }
    if (effect.rename) name = effect.rename;
    if (effect.required !== undefined) optional = !effect.required;
    if (effect.takesId) takesId = true;
  }
  decorators.sort((a, b) => DECORATOR_ORDER.indexOf(a.name) - DECORATOR_ORDER.indexOf(b.name));
  return {
    field: {
      kind: "Scalar",
      name,
      type: {
        name: mapping.type,
        optional: u.list ? false : optional,
        ...(u.list ? { list: true } : {}),
        ...(mapping.enum ? { enum: mapping.enum } : {}),
      },
      decorators,
    },
    takesId,
  };
}

function convertRelation(
  f: FieldDefinitionNode,
  u: Unwrapped,
  at: string,
  ownerType: string,
  types: Map<string, TypeInfo>,
  nodeName: Map<string, string>,
  unionNames: ReadonlySet<string>,
  report: (at: string, d: IssueDraft) => void,
): { field: NodeField; usage?: RelUsage } | undefined {
  const rel = directive(f.directives, "relationship");
  const target = types.get(u.named);
  if (!rel) {
    report(at, {
      severity: "unsupported",
      feature: "@relationship",
      message: "object field without @relationship (or @cypher): not converted",
    });
    return undefined;
  }
  const toUnion = target?.kind === "union";
  if (toUnion ? !unionNames.has(u.named) : target?.kind !== "object" || !nodeName.has(u.named)) {
    report(at, {
      severity: "unsupported",
      feature: "@relationship",
      message: toUnion
        ? `the union "${u.named}" was not converted (see its entry): not converted`
        : target?.kind === "interface"
          ? "relationships to an interface are not supported yet: not converted"
          : `relationships to "${u.named}" (not a @node type) are not supported yet: not converted`,
    });
    return undefined;
  }
  if (u.nested) {
    report(at, {
      severity: "unsupported",
      feature: "nested list",
      message: "lists of lists are not supported: not converted",
    });
    return undefined;
  }
  const relType = stringArg(rel, "type");
  const direction = enumListArg(rel, "direction")?.[0];
  if (!relType || (direction !== "IN" && direction !== "OUT")) {
    report(at, {
      severity: "unsupported",
      feature: "@relationship",
      message: "@relationship needs type and direction: IN | OUT; not converted",
    });
    return undefined;
  }
  const queryDirection = enumListArg(rel, "queryDirection")?.[0];
  if (queryDirection && queryDirection !== "DIRECTED") {
    report(at, {
      severity: "changed",
      feature: "@relationship(queryDirection)",
      message: `queryDirection ${queryDirection} is not supported: Cyphra follows direction ${direction}`,
    });
  }
  for (const a of RELATIONSHIP_API_ARGS) {
    if (rel.arguments?.some((x) => x.name.value === a)) {
      report(at, {
        severity: "ignored",
        feature: `@relationship(${a})`,
        message: "API setting of @neo4j/graphql, no effect on the data model",
      });
    }
  }
  for (const d of f.directives ?? []) {
    const n = d.name.value;
    if (n === "relationship") continue;
    const rule = FIELD_DIRECTIVES[n];
    if (rule?.kind === "report") {
      report(at, { severity: rule.severity, feature: `@${n}`, message: rule.message });
    } else {
      report(at, {
        severity: "unsupported",
        feature: `@${n}`,
        message: `@${n} is not supported on relationship fields: not converted`,
      });
    }
  }
  const self = nodeName.get(ownerType)!;
  const other = toUnion ? u.named : nodeName.get(u.named)!;
  const field: NodeField = {
    kind: "Relational",
    name: f.name.value,
    target: other,
    cardinality: u.list ? "many" : "one",
    optional: u.list ? false : !u.nonNull,
    decorators: [
      {
        name: "relationship",
        args: [
          { key: "type", value: { kind: "string", value: relType } },
          { key: "direction", value: { kind: "identifier", value: direction } },
        ],
      },
    ],
  };
  const propsType = stringArg(rel, "properties");
  if (!propsType) return { field };
  if (toUnion) {
    report(at, UNION_EDGE_PROPERTIES);
    return { field };
  }
  const props = types.get(propsType);
  if (!props || !directive(props.directives, "relationshipProperties")) {
    report(at, {
      severity: "unsupported",
      feature: "@relationship(properties)",
      message: `"${propsType}" is not a @relationshipProperties type: properties not converted`,
    });
    return { field };
  }
  const [start, end] = direction === "OUT" ? [self, other] : [other, self];
  return { field, usage: { propsType, relType, start, end, at } };
}
