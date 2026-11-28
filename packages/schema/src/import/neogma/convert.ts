/**
 * neogma models to a Cyphra schema document, with a report of what was not converted.
 *
 * - Each model becomes a `node` named after its (first) label; extra labels become empty
 *   `interface`s the node implements.
 * - Properties map through {@link shapeToField}; the primary key gets `@id`.
 * - Each relationship alias becomes a list field `alias Target[] @out(TYPE)` / `@in(TYPE)`
 *   (`@relationship(type, direction)` for a type that is not an identifier).
 *   neogma declares each side on its own model: when both models declare the same edges (same
 *   type, opposite directions), the two fields are inverses of each other in Cyphra too.
 * - Relationship properties, from one side or both, become one `relationship` model per edge type
 *   and pair of nodes.
 * - Hooks, statics, instance methods and custom validators are reported, not converted.
 *
 * @packageDocumentation
 */

import type {
  Decorator,
  EnumDeclaration,
  NodeDeclaration,
  NodeField,
  RelationalNodeField,
  RelationshipDeclaration,
  ScalarNodeField,
  SchemaDocument,
} from "../../ast.js";
import { relationFieldDecorator } from "../../model.js";
import type { ImportIssue, ImportResult, IssueDraft } from "../print.js";
import { IDENT, describeSchema, issue, shapeToField } from "./mappings.js";
import {
  NeogmaImportError,
  parseNeogmaSources,
  type NeogmaModel,
  type NeogmaRelationship,
  type NeogmaSchema,
  type NeogmaSource,
  type NeogmaValue,
  type TypeScriptApi,
} from "./parse.js";

export type NeogmaImportResult = ImportResult;

/** Options of {@link convertNeogmaModels}. */
export type NeogmaImportOptions = {
  /** The TypeScript compiler API (`import ts from "typescript"`), used to parse the files. */
  readonly typescript: TypeScriptApi;
};

const DECORATOR_ORDER = ["id", "unique", "index", "default"];

/** A relationship property before its relationship model is named. */
type EdgeProperty = {
  readonly alias: string;
  readonly property: string;
  readonly schema: NeogmaValue | undefined;
  /** `Node.alias` of the relationship declaring it. */
  readonly declaredAt: string;
};

/** Edges of one type between two nodes, and the properties declared on them. */
type Edge = {
  readonly relType: string;
  readonly from: string;
  readonly to: string;
  readonly properties: EdgeProperty[];
};

/**
 * Convert neogma model files to a Cyphra schema. Reads the files statically: no code is run.
 *
 * @throws {NeogmaImportError} When a file does not parse, or no file defines a model.
 */
export function convertNeogmaModels(
  sources: readonly NeogmaSource[],
  options: NeogmaImportOptions,
): NeogmaImportResult {
  const schema = parseNeogmaSources(options.typescript, sources);
  if (schema.models.length === 0) {
    throw new NeogmaImportError(
      `No neogma model found (no @Node class or ModelFactory call) in ${sources.map((s) => s.name).join(", ") || "the input"}.`,
    );
  }
  return convertNeogmaSchema(schema);
}

/** Convert parsed neogma models (see {@link parseNeogmaSources}) to a Cyphra schema. */
export function convertNeogmaSchema(schema: NeogmaSchema): NeogmaImportResult {
  const issues: ImportIssue[] = [];
  const report = (at: string, d: IssueDraft) => issues.push({ at, ...d });
  const notes = new Map<string, string[]>();
  const note = (decl: string, line: string) => {
    const list = notes.get(decl) ?? [];
    list.push(line);
    notes.set(decl, list);
  };

  // Node names: the first label of each model.
  const nodeOf = new Map<string, string>();
  const kept: { model: NeogmaModel; name: string; extra: string[] }[] = [];
  const taken = new Set<string>();
  for (const m of schema.models) {
    const label = m.labels?.[0];
    if (label === undefined) {
      report(
        m.id,
        issue(
          "unsupported",
          "label",
          `the label ${m.labelText ?? ""} could not be read statically: model not converted`,
        ),
      );
      continue;
    }
    if (!IDENT.test(label)) {
      report(
        m.id,
        issue(
          "unsupported",
          "label",
          `label ${JSON.stringify(label)} is not a valid Cyphra name: model not converted`,
        ),
      );
      continue;
    }
    const twin = kept.find((k) => k.name === label);
    if (twin) {
      nodeOf.set(m.id, label);
      report(
        m.id,
        issue(
          "unsupported",
          "label",
          `same label as ${twin.model.id} (${label}): not converted; merge the two models`,
        ),
      );
      continue;
    }
    nodeOf.set(m.id, label);
    taken.add(label);
    kept.push({ model: m, name: label, extra: (m.labels ?? []).slice(1) });
  }

  // Extra labels become interfaces.
  const interfaces: string[] = [];
  for (const k of kept) {
    k.extra = k.extra.filter((l) => {
      const reason = !IDENT.test(l)
        ? "is not a valid Cyphra name"
        : kept.some((o) => o.name === l)
          ? "is also the label of a node model (an interface cannot be one)"
          : undefined;
      if (reason) {
        report(
          k.name,
          issue(
            "unsupported",
            "label",
            `extra label ${JSON.stringify(l)} ${reason}: not converted`,
          ),
        );
        return false;
      }
      if (!interfaces.includes(l)) interfaces.push(l);
      return true;
    });
  }
  for (const i of interfaces) taken.add(i);

  // Enums declared on the way, named after the declaration and field.
  const enums: EnumDeclaration[] = [];
  const enumFor = (owner: string, field: string, values: readonly string[]): string => {
    const base = `${owner}${upperFirst(field)}`;
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}${n}`;
      const existing = enums.find((e) => e.name === name);
      if (existing && sameList(existing.values, values)) return name;
      if (!existing && !taken.has(name)) {
        enums.push({ kind: "Enum", name, values });
        taken.add(name);
        return name;
      }
    }
  };

  /** One property as a scalar field, or undefined (reported) when it cannot be converted. */
  const scalar = (
    owner: string,
    name: string,
    schemaValue: NeogmaValue | undefined,
    annotation: Parameters<typeof shapeToField>[1],
    id: boolean,
  ): ScalarNodeField | undefined => {
    const at = `${owner}.${name}`;
    if (!IDENT.test(name)) {
      report(
        at,
        issue(
          "unsupported",
          "property",
          `${JSON.stringify(name)} is not a valid Cyphra field name: not converted`,
        ),
      );
      note(owner, `${JSON.stringify(name)} (not converted: name)`);
      return undefined;
    }
    const mapped = shapeToField(describeSchema(schemaValue), annotation);
    for (const i of mapped.issues) report(at, i);
    if ("unsupported" in mapped) {
      report(at, mapped.unsupported);
      note(owner, `${name} (not converted: ${mapped.unsupported.feature})`);
      return undefined;
    }
    let type = mapped.type;
    if (mapped.enumValues) type = { ...type, enum: enumFor(owner, name, mapped.enumValues) };
    const decorators: Decorator[] = [...mapped.decorators];
    if (id) {
      if (type.list) {
        report(
          at,
          issue("unsupported", "primary key", "a list cannot be an @id: @id not converted"),
        );
      } else {
        if (type.optional) {
          type = { ...type, optional: false };
          report(
            at,
            issue("changed", "primary key", "an optional primary key became a required @id"),
          );
        }
        decorators.unshift({ name: "id", args: [] });
        const uuid = decorators.find(
          (x) =>
            x.name === "regex" &&
            x.args[0]?.value.kind === "string" &&
            x.args[0].value.value.startsWith("^[0-9a-fA-F]{8}-"),
        );
        if (uuid && type.name === "String" && !decorators.some((x) => x.name === "default")) {
          decorators.push({
            name: "default",
            args: [{ key: "fn", value: { kind: "identifier", value: "uuid" } }],
          });
          report(
            at,
            issue(
              "changed",
              'format: "uuid"',
              "neogma does not generate keys: Cyphra now sets a uuid() when create gets no id (you can still pass one)",
            ),
          );
        }
      }
    }
    return { kind: "Scalar", name, type, decorators: sortDecorators(decorators) };
  };

  // Nodes.
  const edges = new Map<string, Edge>();
  const nodes: NodeDeclaration[] = [];
  for (const { model: m, name: node, extra } of kept) {
    const fields: NodeField[] = [];
    const names = new Set<string>();
    const add = (f: NodeField) => {
      if (names.has(f.name)) {
        report(
          `${node}.${f.name}`,
          issue(
            "unsupported",
            "field",
            `${f.name} is declared twice: the second one is not converted`,
          ),
        );
        return;
      }
      names.add(f.name);
      fields.push(f);
    };
    if (
      m.primaryKey !== undefined &&
      !m.members.some((x) => x.kind === "property" && x.name === m.primaryKey)
    ) {
      report(
        node,
        issue(
          "unsupported",
          "primaryKeyField",
          `primary key ${JSON.stringify(m.primaryKey)} is not a property of the schema: no @id`,
        ),
      );
    }
    for (const member of m.members) {
      if (member.kind === "property") {
        const f = scalar(
          node,
          member.name,
          member.schema,
          member.annotation,
          member.name === m.primaryKey,
        );
        if (f) add(f);
        continue;
      }
      const f = relationField(node, member, nodeOf, edges, (d) =>
        report(`${node}.${member.alias}`, d),
      );
      if (f) add(f);
      else note(node, `${member.alias} (not converted: relationship)`);
    }
    const acc = lowerFirst(node);
    for (const h of m.hooks) {
      const ops =
        h === "beforeDelete"
          ? "delete, deleteMany"
          : h === "beforeSave"
            ? "create, update"
            : "create, createMany";
      report(
        node,
        issue(
          "unsupported",
          h,
          `hook: not converted; port it to a query hook: db.$extends({ query: { ${acc}: { ${ops} } } })`,
        ),
      );
    }
    for (const s of m.statics) {
      report(
        node,
        issue(
          "unsupported",
          `static ${s}`,
          `static method: not converted; add it as a model method: db.$extends({ model: { ${acc}: { ${s} } } })`,
        ),
      );
    }
    for (const s of m.methods) {
      report(
        node,
        issue(
          "unsupported",
          `method ${s}`,
          "instance method: not converted; Cyphra returns plain objects: use a computed field (db.$extends({ result })) or a function",
        ),
      );
    }
    nodes.push({
      kind: "Node",
      name: node,
      ...(extra.length ? { implements: extra } : {}),
      fields,
    });
  }

  // Relationship models.
  const relationships: RelationshipDeclaration[] = [];
  for (const e of edges.values()) {
    if (e.properties.length === 0) continue;
    // `FOLLOWS` gives `Follows`; when taken, `UserFollowsUser`, then `Follows2`, …
    const base = pascal(e.relType) || "Edge";
    let name = [base, `${e.from}${base}${e.to}`].find((n) => !taken.has(n));
    for (let n = 2; name === undefined; n++) if (!taken.has(`${base}${n}`)) name = `${base}${n}`;
    taken.add(name);
    const fields: ScalarNodeField[] = [];
    // A property declared on both sides is converted (and reported) once.
    const seen = new Map<string, { key: string; at: string }>();
    for (const p of e.properties) {
      const key = JSON.stringify(shapeToField(describeSchema(p.schema)));
      const first = seen.get(p.property);
      if (first) {
        if (first.key !== key) {
          report(
            `${name}.${p.property}`,
            issue(
              "changed",
              "properties",
              `declared differently on ${first.at} and ${p.declaredAt}: kept the one on ${first.at}`,
            ),
          );
        }
        continue;
      }
      seen.set(p.property, { key, at: p.declaredAt });
      const f = scalar(name, p.property, p.schema, undefined, false);
      if (!f) continue;
      if (p.alias !== p.property) {
        report(
          `${name}.${p.property}`,
          issue(
            "changed",
            "alias",
            `the alias ${p.alias} (on ${p.declaredAt}) is not kept: Cyphra uses the stored name, $edge: { ${p.property} }`,
          ),
        );
      }
      fields.push(f);
    }
    relationships.push({
      kind: "Relationship",
      name,
      relType: e.relType,
      from: e.from,
      to: e.to,
      fields,
    });
  }

  const interfaceDecls: NodeDeclaration[] = interfaces.map((name) => ({
    kind: "Node",
    name,
    abstract: true,
    fields: [],
  }));

  return {
    document: {
      kind: "Document",
      declarations: [...enums, ...interfaceDecls, ...nodes, ...relationships],
    } satisfies SchemaDocument,
    issues,
    notes,
  };
}

/** A relationship alias as a relation field (and its edges recorded), or undefined (reported). */
function relationField(
  node: string,
  r: NeogmaRelationship,
  nodeOf: ReadonlyMap<string, string>,
  edges: Map<string, Edge>,
  report: (d: IssueDraft) => void,
): RelationalNodeField | undefined {
  if (!IDENT.test(r.alias)) {
    report(
      issue(
        "unsupported",
        "relationship",
        `alias ${JSON.stringify(r.alias)} is not a valid Cyphra field name: not converted`,
      ),
    );
    return undefined;
  }
  const target =
    r.target === "self" ? node : r.target !== undefined ? nodeOf.get(r.target) : undefined;
  if (target === undefined) {
    report(
      issue(
        "unsupported",
        "model",
        r.target !== undefined
          ? `the related model ${r.target} is not among the imported models: not converted; import its file too`
          : `the related model ${r.targetText ? `(${r.targetText}) ` : ""}could not be read statically: not converted`,
      ),
    );
    return undefined;
  }
  if (r.type?.kind !== "string" || r.type.value === "") {
    report(
      issue(
        "unsupported",
        "name",
        "the relationship name (its type) could not be read statically: not converted",
      ),
    );
    return undefined;
  }
  const dir = r.direction?.kind === "string" ? r.direction.value : undefined;
  let direction: "OUT" | "IN";
  if (dir === "out") direction = "OUT";
  else if (dir === "in") direction = "IN";
  else if (dir === "none") {
    direction = "OUT";
    report(
      issue(
        "changed",
        "direction: 'none'",
        "became OUT: a Cyphra field follows one direction, while neogma's 'none' matches edges either way; check how the stored edges point",
      ),
    );
  } else {
    report(
      issue(
        "unsupported",
        "direction",
        "the direction could not be read statically: not converted",
      ),
    );
    return undefined;
  }
  const relType = r.type.value;
  const [from, to] = direction === "OUT" ? [node, target] : [target, node];
  const key = `${relType}\u0000${from}\u0000${to}`;
  let edge = edges.get(key);
  if (!edge) {
    edge = { relType, from, to, properties: [] };
    edges.set(key, edge);
  }
  if (r.properties) {
    const props = edgeProperties(r.properties, `${node}.${r.alias}`, report);
    edge.properties.push(...props);
  }
  return {
    kind: "Relational",
    name: r.alias,
    target,
    cardinality: "many",
    optional: false,
    decorators: [relationFieldDecorator(relType, direction)],
  };
}

/** The `properties` of a relationship: object form, array form or a function returning one. */
function edgeProperties(
  v: NeogmaValue,
  declaredAt: string,
  report: (d: IssueDraft) => void,
): EdgeProperty[] {
  if (v.kind === "function" && v.returns) return edgeProperties(v.returns, declaredAt, report);
  const out: EdgeProperty[] = [];
  const entry = (alias: string, value: NeogmaValue) => {
    if (value.kind === "object" && (value.entries.has("property") || value.entries.has("schema"))) {
      const p = value.entries.get("property");
      out.push({
        alias,
        property: p?.kind === "string" ? p.value : alias,
        schema: value.entries.get("schema"),
        declaredAt,
      });
    } else {
      out.push({ alias, property: alias, schema: value, declaredAt });
    }
  };
  if (v.kind === "object") {
    for (const [alias, value] of v.entries) entry(alias, value);
    return out;
  }
  if (v.kind === "array") {
    for (const item of v.items) {
      const alias = item.kind === "object" ? item.entries.get("alias") : undefined;
      const p = item.kind === "object" ? item.entries.get("property") : undefined;
      const name =
        alias?.kind === "string" ? alias.value : p?.kind === "string" ? p.value : undefined;
      if (name !== undefined && item.kind === "object") entry(name, item);
    }
    return out;
  }
  report(
    issue(
      "unsupported",
      "properties",
      "the relationship properties could not be read statically: not converted",
    ),
  );
  return out;
}

function sortDecorators(decorators: readonly Decorator[]): Decorator[] {
  const rank = (d: Decorator) => {
    const i = DECORATOR_ORDER.indexOf(d.name);
    return i < 0 ? DECORATOR_ORDER.length : i;
  };
  return [...decorators].sort((a, b) => rank(a) - rank(b));
}

function upperFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** `HAS_ORDER` → `HasOrder`, `follows` → `Follows`. */
export function pascal(relType: string): string {
  return relType
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("")
    .replace(/^[0-9]+/, "");
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
