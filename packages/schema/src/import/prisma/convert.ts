/**
 * Convert a Prisma schema to a Cyphra {@link SchemaDocument}.
 *
 * Pure: no file system, no printing. Rules for each type and attribute live in `mappings.ts`;
 * this module walks the schema, pairs the two sides of each relation, turns foreign keys and join
 * models into edges and applies the rules.
 *
 * @packageDocumentation
 */

import type {
  Decorator,
  DecoratorArg,
  EnumDeclaration,
  ModelAttribute,
  NodeDeclaration,
  NodeField,
  RelationalNodeField,
  RelationshipDeclaration,
  ScalarNodeField,
  ScalarTypeName,
  SchemaDocument,
} from "../../ast.js";
import type { ImportIssue, ImportResult, IssueDraft } from "../print.js";
import {
  COMPOSITE_TYPE,
  CYPHRA_TYPE_NAMES,
  FIELD_ATTRIBUTES,
  FIELD_REPORTS,
  ID,
  INDEX,
  MODEL_REPORTS,
  SCALARS,
  UNIQUE,
  UNSUPPORTED_TYPE,
  convertDefault,
  defaultFn,
  derivedRelType,
  foreignKeyDropped,
  issue,
  mapOnDelete,
  nativeType,
  upperSnake,
} from "./mappings.js";
import {
  PrismaImportError,
  parsePrismaSchema,
  prismaArg,
  prismaFieldList,
  type PrismaAttribute,
  type PrismaEnum,
  type PrismaField,
  type PrismaModel,
} from "./parse.js";

/** One Prisma schema file (a multi-file schema has several). */
export type PrismaSource = { readonly name: string; readonly body: string };

export type PrismaImportResult = ImportResult;

/** One side of a relation: a relation field and its `@relation(…)`. */
type Side = {
  readonly model: PrismaModel;
  readonly field: PrismaField;
  readonly target: string;
  readonly name: string | undefined;
  /** Key scalars of this model (`fields: […]`), on the side holding the key. */
  readonly fields: readonly string[] | undefined;
  readonly references: readonly string[] | undefined;
  readonly onDelete: string | undefined;
  readonly onUpdate: string | undefined;
};

/** A relation field once its edge is known. */
type Edge = {
  readonly relType: string;
  readonly direction: "OUT" | "IN";
  /** Node the field points to (the other model, or the far side of a join model). */
  readonly target: string;
  readonly many: boolean;
  readonly optional: boolean;
  readonly onDelete?: "Cascade" | "Restrict";
};

/** An explicit join model that becomes a `relationship` model. */
type JoinModel = {
  readonly model: PrismaModel;
  /** The join model's two key relations, in field order: `from`, then `to`. */
  readonly sides: readonly [Side, Side];
  readonly keyFields: ReadonlySet<string>;
  /** Edge type (the join model's name in upper snake case, made unique). */
  relType: string;
};

const DECORATOR_ORDER = ["id", "unique", "index", "default"];

function at(model: string, field?: string): string {
  return field ? `${model}.${field}` : model;
}

function relationName(f: PrismaField): string | undefined {
  const rel = f.attributes.find((a) => a.name === "relation");
  if (!rel) return undefined;
  const v = prismaArg(rel, "name", 0);
  return v?.kind === "string" ? v.value : undefined;
}

function identArg(attr: PrismaAttribute | undefined, name: string): string | undefined {
  const v = attr ? prismaArg(attr, name) : undefined;
  return v?.kind === "ident" && !v.args ? v.name : undefined;
}

/**
 * Convert a Prisma schema to a Cyphra schema document plus a report of what was not converted.
 * Never throws for unsupported features; only for a file that does not parse or references an
 * unknown type.
 *
 * @param input - The `schema.prisma` text, or the files of a multi-file schema.
 * @throws {PrismaImportError} On a syntax error, an unknown type or a duplicate block.
 */
export function convertPrismaSchema(input: string | readonly PrismaSource[]): PrismaImportResult {
  const sources = typeof input === "string" ? [{ name: "schema.prisma", body: input }] : input;
  const issues: ImportIssue[] = [];
  const report = (where: string, d: IssueDraft) => issues.push({ at: where, ...d });
  const notes = new Map<string, string[]>();
  const note = (decl: string, line: string) => {
    const list = notes.get(decl) ?? [];
    list.push(line);
    notes.set(decl, list);
  };

  // Collect blocks.
  const models = new Map<string, PrismaModel>();
  const composites = new Map<string, PrismaModel>();
  const enums = new Map<string, PrismaEnum>();
  const names = new Set<string>();
  const fileOf = new Map<string, string>();
  for (const src of sources) {
    for (const b of parsePrismaSchema(src.body, src.name).blocks) {
      if (b.kind === "datasource" || b.kind === "generator") {
        const provider = b.entries.get("provider");
        const p = provider?.kind === "string" ? ` (provider "${provider.value}")` : "";
        report(`${b.kind} ${b.name}`, {
          severity: "ignored",
          feature: b.kind,
          message:
            b.kind === "datasource"
              ? `Prisma connection settings${p}: Cyphra connects to Neo4j with NEO4J_URI`
              : `Prisma generator${p}: run cyphra generate instead`,
        });
        continue;
      }
      if (names.has(b.name)) {
        throw new PrismaImportError(
          `${src.name}:${b.line}: "${b.name}" is defined more than once.`,
        );
      }
      names.add(b.name);
      fileOf.set(b.name, src.name);
      if (b.kind === "enum") {
        enums.set(b.name, b);
        continue;
      }
      const model = b as PrismaModel; // datasource and generator blocks were handled above
      if (model.kind === "type") composites.set(b.name, model);
      else if (model.kind === "view") {
        report(b.name, {
          severity: "unsupported",
          feature: "view",
          message: "views are not converted: write the query with the client or $cypher",
        });
      } else if (model.attributes.some((a) => a.name === "ignore")) {
        report(b.name, MODEL_REPORTS.ignore!);
      } else {
        models.set(b.name, model);
      }
    }
  }
  const viewOrIgnored = (t: string) =>
    names.has(t) && !models.has(t) && !enums.has(t) && !composites.has(t);

  // Every field type must exist.
  for (const m of [...models.values(), ...composites.values()]) {
    for (const f of m.fields) {
      if (f.unsupported !== undefined || SCALARS[f.type] || names.has(f.type)) continue;
      throw new PrismaImportError(
        `${fileOf.get(m.name)}:${f.line}: field "${m.name}.${f.name}" has unknown type "${f.type}".`,
      );
    }
  }

  // Enums.
  const enumNames = new Map<string, string | undefined>();
  const enumDecls: EnumDeclaration[] = [];
  for (const e of enums.values()) {
    for (const a of e.attributes) {
      const r = MODEL_REPORTS[a.name];
      report(
        e.name,
        r && a.name === "map"
          ? issue("changed", "@@map", "enum names are not stored: the values are")
          : (r ??
              issue("unsupported", `@@${a.name}`, `unknown attribute @@${a.name}: not converted`)),
      );
    }
    for (const v of e.values) {
      if (v.attributes.some((a) => a.name === "map")) {
        report(
          at(e.name, v.name),
          issue(
            "changed",
            "@map",
            `Cyphra stores the value's name ("${v.name}"), not the mapped database value (Prisma Client returns the name, so export through it)`,
          ),
        );
      }
    }
    if (CYPHRA_TYPE_NAMES.has(e.name) || models.has(e.name) || e.values.length === 0) {
      enumNames.set(e.name, undefined);
      report(
        e.name,
        issue(
          "changed",
          "enum",
          "this enum name cannot be a Cyphra enum (it is a built-in type name): mapped to String, allowed values are not enforced",
        ),
      );
      continue;
    }
    enumNames.set(e.name, e.name);
    enumDecls.push({ kind: "Enum", name: e.name, values: e.values.map((v) => v.name) });
  }

  // Relation sides, grouped by relation (name + pair of models).
  const sidesOf = new Map<string, Side[]>();
  const sideOfField = new Map<PrismaField, Side>();
  for (const m of models.values()) {
    for (const f of m.fields) {
      if (!models.has(f.type) && !viewOrIgnored(f.type)) continue;
      if (f.attributes.some((a) => a.name === "ignore")) continue;
      const rel = f.attributes.find((a) => a.name === "relation");
      const side: Side = {
        model: m,
        field: f,
        target: f.type,
        name: relationName(f),
        fields: rel ? prismaFieldList(prismaArg(rel, "fields")) : undefined,
        references: rel ? prismaFieldList(prismaArg(rel, "references")) : undefined,
        onDelete: identArg(rel, "onDelete"),
        onUpdate: identArg(rel, "onUpdate"),
      };
      if (!models.has(f.type)) continue; // relation to an ignored model or a view: reported below
      const key = `${side.name ?? ""}|${[m.name, f.type].sort().join("|")}`;
      sidesOf.set(key, [...(sidesOf.get(key) ?? []), side]);
      sideOfField.set(f, side);
    }
  }
  const partnerOf = (s: Side): Side | undefined => {
    const key = `${s.name ?? ""}|${[s.model.name, s.target].sort().join("|")}`;
    const group = sidesOf.get(key) ?? [];
    if (group.length !== 2) return undefined;
    return group[0] === s ? group[1] : group[0];
  };

  // Explicit join models.
  const joins = new Map<string, JoinModel>();
  for (const m of models.values()) {
    const join = detectJoinModel(m, sideOfField, partnerOf, models);
    if (join) joins.set(m.name, join);
  }

  // Edges for every relation field.
  const edgeOf = new Map<PrismaField, Edge>();
  /** Model → key scalar → its relation field and edge type. */
  const fkFields = new Map<string, Map<string, { field: string; relType: string }>>();
  const usedTypes = new Map<string, string>(); // relType|start|end → where
  const pickType = (base: string, start: string, end: string, where: string): string => {
    let t = base;
    let n = 2;
    while (usedTypes.has(`${t}|${start}|${end}`)) t = `${base}_${n++}`;
    if (t !== base) {
      report(
        where,
        issue(
          "changed",
          "@relation",
          `edge type ${base} from ${start} to ${end} is taken by ${usedTypes.get(`${base}|${start}|${end}`)}: named ${t}`,
        ),
      );
    }
    usedTypes.set(`${t}|${start}|${end}`, where);
    return t;
  };

  for (const j of joins.values()) {
    const [a, b] = j.sides;
    const relType = pickType(j.relType, a.target, b.target, j.model.name);
    j.relType = relType;
    const backA = partnerOf(a)!;
    const backB = partnerOf(b)!;
    const delA = mapOnDelete(a.onDelete, true, true);
    const delB = mapOnDelete(b.onDelete, true, true);
    if (delA.issue) report(at(j.model.name, a.field.name), delA.issue);
    if (delB.issue) report(at(j.model.name, b.field.name), delB.issue);
    edgeOf.set(backA.field, {
      relType,
      direction: "OUT",
      target: b.target,
      many: true,
      optional: false,
      ...(delA.rule ? { onDelete: delA.rule } : {}),
    });
    edgeOf.set(backB.field, {
      relType,
      direction: "IN",
      target: a.target,
      many: true,
      optional: false,
      ...(delB.rule ? { onDelete: delB.rule } : {}),
    });
    report(
      j.model.name,
      issue(
        "changed",
        "join model",
        `became relationship ${j.model.name}: (${a.target})-[:${relType}]->(${b.target}) edges with its other fields as properties; ${a.target}.${backA.field.name} and ${b.target}.${backB.field.name} now list ${b.target} and ${a.target} nodes (the properties are on $edge)`,
      ),
    );
  }

  const done = new Set<string>();
  for (const [key, group] of sidesOf) {
    if (done.has(key)) continue;
    done.add(key);
    if (group.some((s) => joins.has(s.model.name))) continue; // handled above
    if (group.length > 2) {
      for (const s of group) {
        report(
          at(s.model.name, s.field.name),
          issue(
            "unsupported",
            "@relation",
            'ambiguous relation (several fields with the same relation name): give each relation a distinct @relation("…") name; not converted',
          ),
        );
      }
      continue;
    }
    const keySide = group.find((s) => s.fields?.length);
    if (keySide) {
      const parent = group.find((s) => s !== keySide);
      // The edge goes from the referenced model to the model holding the key.
      const start = keySide.target;
      const end = keySide.model.name;
      const base = keySide.name
        ? upperSnake(keySide.name)
        : derivedRelType(parent?.field.name ?? keySide.model.name);
      const relType = pickType(base, start, end, at(keySide.model.name, keySide.field.name));
      const required = !keySide.field.optional;
      const del = mapOnDelete(keySide.onDelete, required, false);
      if (del.issue) report(at(keySide.model.name, keySide.field.name), del.issue);
      if (keySide.onUpdate) {
        report(
          at(keySide.model.name, keySide.field.name),
          issue(
            "ignored",
            `onUpdate: ${keySide.onUpdate}`,
            "edges do not hold key values, so updating a key never touches them",
          ),
        );
      }
      edgeOf.set(keySide.field, {
        relType,
        direction: "IN",
        target: start,
        many: false,
        optional: keySide.field.optional,
      });
      if (parent) {
        edgeOf.set(parent.field, {
          relType,
          direction: "OUT",
          target: end,
          many: parent.field.list,
          optional: parent.field.list ? false : true,
          ...(del.rule ? { onDelete: del.rule } : {}),
        });
        if (!parent.field.list) {
          report(
            at(parent.model.name, parent.field.name),
            issue(
              "changed",
              "one-to-one",
              `Neo4j has no constraint across relationships, so a second ${relType} edge is not refused by the database; the client replaces the edge when you connect another node`,
            ),
          );
        }
      } else if (del.rule) {
        report(
          at(keySide.model.name, keySide.field.name),
          issue(
            "unsupported",
            `onDelete: ${keySide.onDelete ?? "Restrict"}`,
            `${start} has no field for this relation, so the rule has nowhere to go: add a back-relation field to keep it`,
          ),
        );
      }
      const keys =
        fkFields.get(keySide.model.name) ?? new Map<string, { field: string; relType: string }>();
      for (const k of keySide.fields ?? []) keys.set(k, { field: keySide.field.name, relType });
      fkFields.set(keySide.model.name, keys);
      continue;
    }
    if (group.length === 2 && group.every((s) => s.field.list)) {
      // Implicit many-to-many: Prisma's `A` side is the model whose name sorts first.
      const [a, b] = [...group].sort((x, y) =>
        x.model.name === y.model.name
          ? x.field.name.localeCompare(y.field.name)
          : x.model.name.localeCompare(y.model.name),
      ) as [Side, Side];
      const base = a.name ? upperSnake(a.name) : derivedRelType(a.field.name);
      const relType = pickType(base, a.model.name, b.model.name, at(a.model.name, a.field.name));
      edgeOf.set(a.field, {
        relType,
        direction: "OUT",
        target: b.model.name,
        many: true,
        optional: false,
      });
      edgeOf.set(b.field, {
        relType,
        direction: "IN",
        target: a.model.name,
        many: true,
        optional: false,
      });
      if (a.model.name === b.model.name) {
        report(
          at(a.model.name, a.field.name),
          issue(
            "changed",
            "many-to-many",
            `self relation: ${a.model.name}.${a.field.name} became the OUT side of ${relType} (and ${b.field.name} the IN side); check that it matches column A of the _${a.name ?? ""} join table when you migrate the data`,
          ),
        );
      }
      continue;
    }
    for (const s of group) {
      report(
        at(s.model.name, s.field.name),
        issue(
          "unsupported",
          "@relation",
          group.length === 1
            ? "relation without fields/references and without a back-relation field: not converted"
            : "relation without fields/references on either side (and not a list on both): not converted",
        ),
      );
    }
  }

  // Nodes.
  const declarations: NodeDeclaration[] = [];
  const relationships: RelationshipDeclaration[] = [];
  for (const m of models.values()) {
    const join = joins.get(m.name);
    if (join) {
      relationships.push(convertJoinModel(join, enumNames, enums, composites, report, note));
      continue;
    }
    for (const a of m.attributes) {
      const r = MODEL_REPORTS[a.name];
      if (r) report(m.name, r);
    }
    const keys = fkFields.get(m.name) ?? new Map<string, { field: string; relType: string }>();
    const fields: NodeField[] = [];
    const scalars = new Map<string, ScalarNodeField>();
    for (const f of m.fields) {
      const where = at(m.name, f.name);
      if (f.attributes.some((x) => x.name === "ignore")) {
        report(where, FIELD_REPORTS.ignore!);
        note(m.name, `${f.name} ${typeText(f)} (not converted: @ignore)`);
        continue;
      }
      if (models.has(f.type) || viewOrIgnored(f.type)) {
        const edge = edgeOf.get(f);
        if (!edge) {
          if (viewOrIgnored(f.type)) {
            report(
              where,
              issue(
                "unsupported",
                "@relation",
                `"${f.type}" is a view or an @@ignore model: not converted`,
              ),
            );
          }
          note(m.name, `${f.name} ${typeText(f)} (not converted: relation)`);
          continue;
        }
        fields.push(relationField(f.name, edge));
        continue;
      }
      if (keys.has(f.name)) {
        report(
          where,
          issue(
            "changed",
            "foreign key",
            foreignKeyDropped(keys.get(f.name)!.field, keys.get(f.name)!.relType),
          ),
        );
        note(
          m.name,
          `${f.name} ${typeText(f)} (foreign key of ${keys.get(f.name)!.field}: replaced by the edge)`,
        );
        continue;
      }
      const scalar = convertScalar(f, where, "node", enumNames, enums, composites, report);
      if (!scalar) {
        note(m.name, `${f.name} ${typeText(f)} (not converted: type not supported)`);
        continue;
      }
      fields.push(scalar);
      scalars.set(f.name, scalar);
    }
    const attributes = blockAttributes(m, scalars, keys, report);
    // Single-field @@id / @@unique / @@index become field decorators.
    const finalFields = fields.map((f) => {
      const extra = attributes.fieldDecorators.get(f.name);
      if (!extra || f.kind !== "Scalar") return f;
      const decorators = [...f.decorators];
      for (const d of extra) {
        if (d.name === "id" && decorators.some((x) => x.name === "unique")) {
          decorators.splice(
            decorators.findIndex((x) => x.name === "unique"),
            1,
          );
        }
        if (d.name === "index" && decorators.some((x) => x.name === "id" || x.name === "unique"))
          continue;
        if (d.name === "unique" && decorators.some((x) => x.name === "id" || x.name === "unique"))
          continue;
        if (!decorators.some((x) => x.name === d.name)) decorators.push(d);
      }
      // `@index` is redundant once the field is unique.
      const cleaned = decorators.some((x) => x.name === "id" || x.name === "unique")
        ? decorators.filter((x) => x.name !== "index")
        : decorators;
      return { ...f, decorators: sortDecorators(cleaned) };
    });
    declarations.push({
      kind: "Node",
      name: m.name,
      fields: finalFields,
      ...(attributes.model.length ? { attributes: attributes.model } : {}),
    });
  }

  return {
    document: {
      kind: "Document",
      declarations: [...enumDecls, ...declarations, ...relationships],
    } satisfies SchemaDocument,
    issues,
    notes,
  };
}

function typeText(f: PrismaField): string {
  const t = f.unsupported !== undefined ? `Unsupported(${JSON.stringify(f.unsupported)})` : f.type;
  return `${t}${f.list ? "[]" : ""}${f.optional ? "?" : ""}`;
}

function sortDecorators(decorators: readonly Decorator[]): Decorator[] {
  const rank = (d: Decorator) => {
    const i = DECORATOR_ORDER.indexOf(d.name);
    return i < 0 ? DECORATOR_ORDER.length : i;
  };
  return [...decorators].sort((a, b) => rank(a) - rank(b));
}

function relationField(name: string, edge: Edge): RelationalNodeField {
  const args: DecoratorArg[] = [
    { key: "type", value: { kind: "string", value: edge.relType } },
    { key: "direction", value: { kind: "identifier", value: edge.direction } },
  ];
  if (edge.onDelete)
    args.push({ key: "onDelete", value: { kind: "identifier", value: edge.onDelete } });
  return {
    kind: "Relational",
    name,
    target: edge.target,
    cardinality: edge.many ? "many" : "one",
    optional: edge.many ? false : edge.optional,
    decorators: [{ name: "relationship", args }],
  };
}

/**
 * A join model: exactly two relation fields, both required and holding a key, whose keys are
 * covered by a `@@id` or `@@unique`, each with a list back-relation, and no other relation
 * pointing to it.
 */
function detectJoinModel(
  m: PrismaModel,
  sideOfField: ReadonlyMap<PrismaField, Side>,
  partnerOf: (s: Side) => Side | undefined,
  models: ReadonlyMap<string, PrismaModel>,
): JoinModel | undefined {
  const rels = m.fields.filter((f) => sideOfField.has(f)).map((f) => sideOfField.get(f)!);
  if (rels.length !== 2) return undefined;
  if (m.fields.some((f) => models.has(f.type) && !sideOfField.has(f))) return undefined;
  const [a, b] = rels as [Side, Side];
  for (const s of rels) {
    if (!s.fields?.length || s.field.optional || s.field.list) return undefined;
    const back = partnerOf(s);
    if (!back || !back.field.list || back.model.name === m.name) return undefined;
  }
  // No other model points to the join model.
  for (const other of models.values()) {
    if (other === m) continue;
    for (const f of other.fields) {
      if (f.type !== m.name) continue;
      const s = sideOfField.get(f);
      if (!s || (s !== partnerOf(a) && s !== partnerOf(b))) return undefined;
    }
  }
  const keyFields = new Set([...(a.fields ?? []), ...(b.fields ?? [])]);
  const covers = m.attributes.some((attr) => {
    if (attr.name !== "id" && attr.name !== "unique") return false;
    const list = prismaFieldList(prismaArg(attr, "fields", 0));
    return (
      list !== undefined && list.length === keyFields.size && list.every((x) => keyFields.has(x))
    );
  });
  if (!covers) return undefined;
  return { model: m, sides: [a, b], keyFields, relType: upperSnake(m.name) };
}

function convertJoinModel(
  j: JoinModel,
  enumNames: ReadonlyMap<string, string | undefined>,
  enums: ReadonlyMap<string, PrismaEnum>,
  composites: ReadonlyMap<string, PrismaModel>,
  report: (at: string, d: IssueDraft) => void,
  note: (decl: string, line: string) => void,
): RelationshipDeclaration {
  const m = j.model;
  const fields: ScalarNodeField[] = [];
  for (const f of m.fields) {
    const where = at(m.name, f.name);
    if (f === j.sides[0].field || f === j.sides[1].field) continue;
    if (j.keyFields.has(f.name)) continue; // the edge's endpoints
    if (f.attributes.some((x) => x.name === "ignore")) {
      report(where, FIELD_REPORTS.ignore!);
      continue;
    }
    if (f.attributes.some((x) => x.name === "id")) {
      report(
        where,
        issue(
          "changed",
          "@id",
          "the join row's own id is not needed on an edge (the edge is found from its nodes): dropped",
        ),
      );
      note(m.name, `${f.name} ${typeText(f)} (not converted: id of the join row)`);
      continue;
    }
    const scalar = convertScalar(f, where, "relationship", enumNames, enums, composites, report);
    if (!scalar) {
      note(m.name, `${f.name} ${typeText(f)} (not converted: type not supported)`);
      continue;
    }
    fields.push(scalar);
  }
  for (const attr of m.attributes) {
    const list = prismaFieldList(prismaArg(attr, "fields", 0));
    const onKeys = list !== undefined && list.every((x) => j.keyFields.has(x));
    if ((attr.name === "id" || attr.name === "unique" || attr.name === "index") && onKeys) {
      if (attr.name === "index") continue; // Neo4j finds the edges from either node
      report(
        m.name,
        issue(
          "changed",
          `@@${attr.name}`,
          `became the edge's endpoints: Neo4j has no constraint over relationships, but the client's connect keeps one ${j.relType} edge per pair of nodes (it MERGEs); raw Cypher CREATE does not`,
        ),
      );
      continue;
    }
    if (attr.name === "index" && list?.length === 1) {
      const f = fields.find((x) => x.name === list[0]);
      if (f && !f.decorators.some((d) => d.name === "unique")) {
        const i = fields.indexOf(f);
        fields[i] = { ...f, decorators: sortDecorators([...f.decorators, INDEX]) };
        continue;
      }
    }
    const r = MODEL_REPORTS[attr.name];
    report(
      m.name,
      r ??
        issue(
          "unsupported",
          `@@${attr.name}`,
          "model attributes over several fields are supported on nodes, not on relationships: not converted",
        ),
    );
  }
  return {
    kind: "Relationship",
    name: m.name,
    relType: j.relType,
    from: j.sides[0].target,
    to: j.sides[1].target,
    fields,
  };
}

/** Convert a scalar, enum or composite-typed field; `undefined` when it cannot be converted. */
function convertScalar(
  f: PrismaField,
  where: string,
  owner: "node" | "relationship",
  enumNames: ReadonlyMap<string, string | undefined>,
  enums: ReadonlyMap<string, PrismaEnum>,
  composites: ReadonlyMap<string, PrismaModel>,
  report: (at: string, d: IssueDraft) => void,
): ScalarNodeField | undefined {
  if (f.unsupported !== undefined) {
    report(where, issue("unsupported", "Unsupported", UNSUPPORTED_TYPE));
    return undefined;
  }
  let type: ScalarTypeName;
  let enumName: string | undefined;
  let list = f.list;
  let enumValues: readonly string[] | undefined;
  if (enums.has(f.type)) {
    enumName = enumNames.get(f.type);
    type = enumName ? "Enum" : "String";
    enumValues = enums.get(f.type)!.values.map((v) => v.name);
  } else if (composites.has(f.type)) {
    report(where, COMPOSITE_TYPE);
    type = "Json";
    list = false;
  } else {
    const mapping = SCALARS[f.type]!;
    if ("unsupported" in mapping) {
      report(where, issue("unsupported", f.type, mapping.unsupported));
      return undefined;
    }
    type = mapping.type;
    if (mapping.issue) report(where, mapping.issue);
  }
  if (type === "Json" && list) {
    report(
      where,
      issue(
        "changed",
        "Json[]",
        "became Json: one Json value holding the array (Cyphra has no Json[])",
      ),
    );
    list = false;
  }

  const decorators: Decorator[] = [];
  const add = (d: Decorator) => {
    if (!decorators.some((x) => x.name === d.name)) decorators.push(d);
  };
  let id = false;
  // Native types first: they can change the type (`@db.Date`).
  for (const a of f.attributes) {
    if (!a.name.startsWith("db.")) continue;
    const effect = nativeType(a.name, a.args, type);
    if (effect.type) type = effect.type;
    for (const d of effect.decorators ?? []) add(d);
    if (effect.issue) report(where, effect.issue);
  }
  for (const a of f.attributes) {
    if (a.name.startsWith("db.")) continue;
    switch (a.name) {
      case "id":
        if (owner === "relationship") break;
        id = true;
        add(ID);
        break;
      case "unique":
        if (prismaArg(a, "map")) {
          report(
            where,
            issue("ignored", "@unique(map)", "constraint names are generated by Cyphra"),
          );
        }
        add(UNIQUE);
        break;
      case "default": {
        const v = prismaArg(a, "value", 0);
        if (!v) break;
        const effect = convertDefault(v, {
          type,
          list,
          id,
          ...(enumName && enumValues ? { enumValues } : {}),
        });
        if (effect.issue) report(where, effect.issue);
        if (effect.decorator) add(effect.decorator);
        break;
      }
      case "updatedAt":
        report(where, FIELD_REPORTS.updatedAt!);
        if (!decorators.some((d) => d.name === "default")) add(defaultFn("now"));
        break;
      case "map":
        report(where, FIELD_REPORTS.map!);
        break;
      default:
        if (!FIELD_ATTRIBUTES.has(a.name)) {
          report(
            where,
            issue("unsupported", `@${a.name}`, `unknown attribute @${a.name}: not converted`),
          );
        }
    }
  }
  // Cyphra restrictions.
  const drop = (name: string, why: string) => {
    const i = decorators.findIndex((d) => d.name === name);
    if (i < 0) return;
    decorators.splice(i, 1);
    report(where, issue("unsupported", `@${name}`, why));
  };
  if (type === "Json") {
    drop("id", "@id is not valid on a Json field: not converted");
    drop("unique", "@unique is not valid on a Json field: not converted");
  }
  if (list) {
    drop("id", "@id is not valid on a list: not converted");
    drop("unique", "@unique on a list is not supported by Cyphra: not converted");
  }
  if (decorators.some((d) => d.name === "id")) {
    const i = decorators.findIndex((d) => d.name === "unique");
    if (i >= 0) decorators.splice(i, 1);
  }
  if (owner === "relationship" && f.attributes.some((a) => a.name === "id")) {
    report(
      where,
      issue("changed", "@id", "an edge property cannot be an @id: kept as a plain property"),
    );
  }
  return {
    kind: "Scalar",
    name: f.name,
    type: {
      name: type,
      optional: list ? false : f.optional,
      ...(list ? { list: true } : {}),
      ...(enumName && type === "Enum" ? { enum: enumName } : {}),
    },
    decorators: sortDecorators(decorators),
  };
}

/** `@@id`, `@@unique`, `@@index` and `@@fulltext` of a node model. */
function blockAttributes(
  m: PrismaModel,
  scalars: ReadonlyMap<string, ScalarNodeField>,
  keys: ReadonlyMap<string, { readonly field: string; readonly relType: string }>,
  report: (at: string, d: IssueDraft) => void,
): { model: ModelAttribute[]; fieldDecorators: Map<string, Decorator[]> } {
  const model: ModelAttribute[] = [];
  const fieldDecorators = new Map<string, Decorator[]>();
  const addField = (name: string, d: Decorator) =>
    fieldDecorators.set(name, [...(fieldDecorators.get(name) ?? []), d]);
  const hasId = [...scalars.values()].some((f) => f.decorators.some((d) => d.name === "id"));
  const seen = new Set<string>();
  for (const attr of m.attributes) {
    if (!["id", "unique", "index", "fulltext"].includes(attr.name)) {
      if (!MODEL_REPORTS[attr.name]) {
        report(
          m.name,
          issue("unsupported", `@@${attr.name}`, `unknown attribute @@${attr.name}: not converted`),
        );
      }
      continue;
    }
    const feature = `@@${attr.name}`;
    const list = prismaFieldList(prismaArg(attr, "fields", 0));
    if (!list || list.length === 0) {
      report(m.name, issue("unsupported", feature, "needs a list of fields: not converted"));
      continue;
    }
    const onKeys = list.filter((x) => keys.has(x));
    let fields = list;
    if (onKeys.length) {
      const relations = [...new Set(onKeys.map((k) => keys.get(k)!.field))].join(", ");
      if (attr.name === "index") {
        fields = list.filter((x) => !keys.has(x));
        if (fields.length === 0) {
          report(
            m.name,
            issue(
              "ignored",
              feature,
              `index on the foreign key of ${relations}: not needed, Neo4j follows the edge from the node`,
            ),
          );
          continue;
        }
        report(
          m.name,
          issue(
            "changed",
            feature,
            `the foreign key of ${relations} is not a property: indexed the other fields (${fields.join(", ")})`,
          ),
        );
      } else {
        report(
          m.name,
          issue(
            "unsupported",
            feature,
            `covers the foreign key of ${relations}: Neo4j constraints cannot span a relationship, so this is not converted; check it in your code before you create`,
          ),
        );
        continue;
      }
    }
    const missing = fields.find((x) => !scalars.has(x));
    if (missing) {
      report(
        m.name,
        issue("unsupported", feature, `field "${missing}" was not converted: not converted`),
      );
      continue;
    }
    if (attr.name === "fulltext") {
      const bad = fields.find((x) => scalars.get(x)!.type.name !== "String");
      if (bad) {
        report(
          m.name,
          issue("unsupported", feature, `field "${bad}" is not a String: not converted`),
        );
        continue;
      }
      model.push({ kind: "ModelAttribute", name: "fulltext", fields, args: [] });
      continue;
    }
    const multi = fields.find((x) => {
      const t = scalars.get(x)!.type;
      return t.list || t.name === "Json";
    });
    if (multi && (fields.length > 1 || attr.name !== "index")) {
      report(
        m.name,
        issue(
          "unsupported",
          feature,
          `field "${multi}" is a list or Json, which Cyphra constraints and composite indexes do not cover: not converted`,
        ),
      );
      continue;
    }
    if (fields.length === 1) {
      const name = fields[0]!;
      if (attr.name === "id") {
        addField(name, hasId ? UNIQUE : ID);
      } else if (attr.name === "unique") {
        addField(name, UNIQUE);
      } else if (scalars.get(name)!.type.name !== "Json") {
        addField(name, INDEX);
      }
      continue;
    }
    const kind = attr.name === "index" ? "index" : "unique";
    const sig = `${kind}|${kind === "unique" ? [...fields].sort().join(",") : fields.join(",")}`;
    if (seen.has(sig) || (kind === "index" && seen.has(`unique|${fields.join(",")}`))) continue;
    seen.add(sig);
    if (kind === "unique") seen.add(`unique|${fields.join(",")}`);
    const args: DecoratorArg[] = [];
    const given = prismaArg(attr, "name");
    if (
      kind === "unique" &&
      given?.kind === "string" &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(given.value)
    ) {
      args.push({ key: "name", value: { kind: "string", value: given.value } });
    }
    if (attr.name === "id") {
      report(
        m.name,
        issue(
          "changed",
          "@@id",
          `composite id became @@unique([${fields.join(", ")}]): a Cyphra node has a single-field @id; find it with the ${fields.join("_")} unique key`,
        ),
      );
    }
    model.push({ kind: "ModelAttribute", name: kind, fields, args });
  }
  return { model, fieldDecorators };
}
