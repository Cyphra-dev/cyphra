/**
 * Database introspection for `cyphra pull`: read labels, relationship types, property types,
 * constraints and indexes from a live Neo4j database and turn them into a `.cyphra` schema.
 *
 * Split in two so the conversion is testable without a database:
 * {@link introspectDatabase} (queries) → {@link schemaFromIntrospection} (pure).
 *
 * @packageDocumentation
 */

import type {
  Decorator,
  NodeDeclaration,
  RelationalNodeField,
  RelationshipDeclaration,
  ScalarNodeField,
  ScalarTypeName,
  SchemaDocument,
} from "@cyphra/schema";
import neo4j from "neo4j-driver";
import { toNative, type CyphraClient } from "@cyphra/runtime";
import { CYPHRA_MIGRATION_LABEL } from "./tracker.js";

export type IntrospectedProperty = {
  readonly propertyName: string;
  readonly propertyTypes: readonly string[];
  readonly mandatory: boolean;
};

export type IntrospectionResult = {
  /** One entry per label combination (`db.schema.nodeTypeProperties`). */
  readonly nodeTypes: readonly {
    readonly labels: readonly string[];
    readonly properties: readonly IntrospectedProperty[];
  }[];
  /** One entry per relationship type (`db.schema.relTypeProperties`). */
  readonly relTypes: readonly {
    readonly type: string;
    readonly properties: readonly IntrospectedProperty[];
    /** Sampled (start labels, end labels) combinations. */
    readonly endpoints: readonly {
      readonly from: readonly string[];
      readonly to: readonly string[];
    }[];
  }[];
  readonly constraints: readonly {
    readonly name: string;
    readonly type: string;
    readonly entityType: string;
    readonly labelsOrTypes: readonly string[];
    readonly properties: readonly string[];
  }[];
  readonly indexes: readonly {
    readonly name: string;
    readonly type: string;
    readonly entityType: string;
    readonly labelsOrTypes: readonly string[];
    readonly properties: readonly string[];
    readonly owningConstraint: string | null;
  }[];
};

/** Edges sampled per relationship type to discover its endpoint labels. */
export const ENDPOINT_SAMPLE_SIZE = 10_000;

function stripRelType(raw: string): string {
  // db.schema.relTypeProperties returns ":`TYPE`".
  const t = raw.startsWith(":") ? raw.slice(1) : raw;
  return t.startsWith("`") && t.endsWith("`") ? t.slice(1, -1).replace(/``/g, "`") : t;
}

/**
 * Read the database's implicit schema. Read-only; samples at most {@link ENDPOINT_SAMPLE_SIZE}
 * edges per relationship type.
 */
export async function introspectDatabase(client: CyphraClient): Promise<IntrospectionResult> {
  return client.withSession(async (session) => {
    const rows = async (text: string, params: Record<string, unknown> = {}) =>
      (await session.run(text, params)).records.map(
        (r) => toNative(r.toObject()) as Record<string, unknown>,
      );

    const nodeRows = await rows(
      "CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes, mandatory RETURN *",
    );
    const byCombo = new Map<string, { labels: string[]; properties: IntrospectedProperty[] }>();
    for (const r of nodeRows) {
      const labels = [...(r.nodeLabels as string[])].sort();
      const key = JSON.stringify(labels);
      const entry = byCombo.get(key) ?? { labels, properties: [] };
      byCombo.set(key, entry);
      if (r.propertyName) {
        entry.properties.push({
          propertyName: r.propertyName as string,
          propertyTypes: (r.propertyTypes as string[] | null) ?? [],
          mandatory: Boolean(r.mandatory),
        });
      }
    }

    const relRows = await rows(
      "CALL db.schema.relTypeProperties() YIELD relType, propertyName, propertyTypes, mandatory RETURN *",
    );
    const byType = new Map<string, IntrospectedProperty[]>();
    for (const r of relRows) {
      const type = stripRelType(r.relType as string);
      const props = byType.get(type) ?? [];
      byType.set(type, props);
      if (r.propertyName) {
        props.push({
          propertyName: r.propertyName as string,
          propertyTypes: (r.propertyTypes as string[] | null) ?? [],
          mandatory: Boolean(r.mandatory),
        });
      }
    }

    const relTypes: IntrospectionResult["relTypes"][number][] = [];
    for (const [type, properties] of byType) {
      const ends = await rows(
        `MATCH ()-[r:\`${type.replace(/`/g, "``")}\`]->() WITH r LIMIT $limit
         RETURN DISTINCT labels(startNode(r)) AS from, labels(endNode(r)) AS to`,
        { limit: neo4jInt(ENDPOINT_SAMPLE_SIZE) },
      );
      relTypes.push({
        type,
        properties,
        endpoints: ends.map((e) => ({ from: e.from as string[], to: e.to as string[] })),
      });
    }

    const constraints = (
      await rows(
        "SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN *",
      )
    ).map((c) => ({
      name: c.name as string,
      type: c.type as string,
      entityType: c.entityType as string,
      labelsOrTypes: (c.labelsOrTypes as string[] | null) ?? [],
      properties: (c.properties as string[] | null) ?? [],
    }));

    const indexes = (
      await rows(
        "SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, owningConstraint RETURN *",
      )
    ).map((i) => ({
      name: i.name as string,
      type: i.type as string,
      entityType: i.entityType as string,
      labelsOrTypes: (i.labelsOrTypes as string[] | null) ?? [],
      properties: (i.properties as string[] | null) ?? [],
      owningConstraint: (i.owningConstraint as string | null) ?? null,
    }));

    return { nodeTypes: [...byCombo.values()], relTypes, constraints, indexes };
  });
}

function neo4jInt(n: number): unknown {
  return neo4j.int(n);
}

// ---------------------------------------------------------------------------
// Pure conversion
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const TYPE_MAP: Record<string, ScalarTypeName> = {
  String: "String",
  Long: "Int",
  Integer: "Int",
  Double: "Float",
  Float: "Float",
  Boolean: "Boolean",
  DateTime: "DateTime",
  ZonedDateTime: "DateTime",
  LocalDateTime: "DateTime",
  Date: "Date",
};

function mapType(types: readonly string[]): { name: ScalarTypeName; list: boolean } | null {
  const mapped = new Set<string>();
  let list: boolean | undefined;
  for (const raw of types) {
    const isList = raw.endsWith("Array") || raw.startsWith("List");
    const base = raw.replace(/Array$/, "").replace(/^List<(.*)>$/, "$1");
    const t = TYPE_MAP[base];
    if (!t) return null;
    if (list !== undefined && list !== isList) return null;
    list = isList;
    mapped.add(t);
  }
  if (mapped.size === 0) return null;
  if (mapped.size === 1) return { name: [...mapped][0] as ScalarTypeName, list: Boolean(list) };
  if ([...mapped].every((t) => t === "Int" || t === "Float"))
    return { name: "Float", list: Boolean(list) };
  return null;
}

function camel(type: string): string {
  const parts = type.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const s = parts
    .map((p, i) =>
      i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(),
    )
    .join("");
  return /^[A-Za-z_]/.test(s) ? s : `rel${s}`;
}

function pascal(type: string): string {
  const c = camel(type);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  let i = 2;
  while (taken.has(name)) name = `${base}${i++}`;
  taken.add(name);
  return name;
}

const dec = (name: string): Decorator => ({ name, args: [] });

/**
 * Convert introspection results into a `.cyphra` {@link SchemaDocument}.
 *
 * - Properties: required when present on every node of the label; types mapped from Neo4j's.
 * - Single-property uniqueness constraints become `@id` (property `id` or constraint `…_id`) / `@unique`;
 *   single-property range indexes become `@index`.
 * - Every sampled `(start)-[:TYPE]->(end)` pair becomes an `OUT` field on the start node and an `IN`
 *   field (`…By`) on the end node, both to-many. Relationship types with properties also get a
 *   `relationship { … }` model.
 */
export function schemaFromIntrospection(input: IntrospectionResult): {
  doc: SchemaDocument;
  warnings: string[];
} {
  const warnings: string[] = [];

  // --- labels and their properties ------------------------------------------------
  type PropAcc = { types: Set<string>; mandatoryIn: number; presentIn: number };
  const labels = new Map<string, { combos: number; props: Map<string, PropAcc> }>();
  const ensureLabel = (l: string) => {
    let e = labels.get(l);
    if (!e) {
      e = { combos: 0, props: new Map() };
      labels.set(l, e);
    }
    return e;
  };
  const skipLabel = (l: string) => l === CYPHRA_MIGRATION_LABEL || !IDENT.test(l);

  for (const nt of input.nodeTypes) {
    for (const l of nt.labels) {
      if (skipLabel(l)) {
        if (l !== CYPHRA_MIGRATION_LABEL)
          warnings.push(`Skipped label "${l}": not a valid identifier.`);
        continue;
      }
      const e = ensureLabel(l);
      e.combos += 1;
      for (const p of nt.properties) {
        const acc = e.props.get(p.propertyName) ?? {
          types: new Set(),
          mandatoryIn: 0,
          presentIn: 0,
        };
        e.props.set(p.propertyName, acc);
        p.propertyTypes.forEach((t) => acc.types.add(t));
        acc.presentIn += 1;
        if (p.mandatory) acc.mandatoryIn += 1;
      }
    }
  }
  for (const rt of input.relTypes) {
    for (const ep of rt.endpoints) {
      for (const l of [...ep.from, ...ep.to]) if (!skipLabel(l)) ensureLabel(l);
    }
  }

  // --- constraints / indexes ----------------------------------------------------
  const uniqueOn = new Map<string, { prop: string; name: string }[]>();
  const relUnique = new Set<string>();
  const indexOn = new Set<string>();
  for (const c of input.constraints) {
    if (c.properties.length !== 1 || c.labelsOrTypes.length !== 1) continue;
    const key = c.labelsOrTypes[0]!;
    if (c.type === "UNIQUENESS" || (c.type.includes("UNIQUE") && c.entityType === "NODE")) {
      const list = uniqueOn.get(key) ?? [];
      list.push({ prop: c.properties[0]!, name: c.name });
      uniqueOn.set(key, list);
    } else if (c.entityType === "RELATIONSHIP" && c.type.includes("UNIQUE")) {
      relUnique.add(`${key}.${c.properties[0]}`);
    }
  }
  for (const i of input.indexes) {
    if (
      i.type !== "RANGE" ||
      i.owningConstraint ||
      i.properties.length !== 1 ||
      i.labelsOrTypes.length !== 1
    ) {
      continue;
    }
    indexOn.add(`${i.entityType}:${i.labelsOrTypes[0]}.${i.properties[0]}`);
  }

  // --- node declarations ---------------------------------------------------------
  const nodeFields = new Map<string, (ScalarNodeField | RelationalNodeField)[]>();
  const taken = new Map<string, Set<string>>();
  for (const [label, e] of [...labels].sort(([a], [b]) => a.localeCompare(b))) {
    const uniques = uniqueOn.get(label) ?? [];
    const idProp =
      uniques.find((u) => u.prop === "id")?.prop ?? uniques.find((u) => /_id$/.test(u.name))?.prop;
    const fields: ScalarNodeField[] = [];
    const ordered = [...e.props].sort(([a], [b]) =>
      a === idProp ? -1 : b === idProp ? 1 : a.localeCompare(b),
    );
    for (const [prop, acc] of ordered) {
      if (!IDENT.test(prop)) {
        warnings.push(`Skipped ${label}.${prop}: not a valid identifier.`);
        continue;
      }
      const t = mapType([...acc.types]);
      if (!t) {
        warnings.push(
          `Skipped ${label}.${prop}: unsupported or mixed types (${[...acc.types].join(", ")}).`,
        );
        continue;
      }
      const required = !t.list && acc.mandatoryIn === e.combos;
      const decorators: Decorator[] = [];
      if (prop === idProp && required) decorators.push(dec("id"));
      else if (uniques.some((u) => u.prop === prop)) decorators.push(dec("unique"));
      else if (indexOn.has(`NODE:${label}.${prop}`)) decorators.push(dec("index"));
      fields.push({
        kind: "Scalar",
        name: prop,
        type: { name: t.name, optional: !required && !t.list, ...(t.list ? { list: true } : {}) },
        decorators,
      });
    }
    nodeFields.set(label, fields);
    taken.set(label, new Set(fields.map((f) => f.name)));
  }

  // --- relations ------------------------------------------------------------------
  const relationships: RelationshipDeclaration[] = [];
  const declNames = new Set(labels.keys());
  for (const rt of [...input.relTypes].sort((a, b) => a.type.localeCompare(b.type))) {
    const pairs: { from: string; to: string }[] = [];
    for (const ep of rt.endpoints) {
      for (const from of ep.from) {
        for (const to of ep.to) {
          if (skipLabel(from) || skipLabel(to)) continue;
          if (!pairs.some((p) => p.from === from && p.to === to)) pairs.push({ from, to });
        }
      }
    }
    if (pairs.length === 0) {
      warnings.push(
        `Relationship type :${rt.type} has no usable endpoints in the sample; skipped.`,
      );
      continue;
    }
    const outTargets = (from: string) => pairs.filter((p) => p.from === from).length;
    const inSources = (to: string) => pairs.filter((p) => p.to === to).length;
    const relDecorator = (direction: "OUT" | "IN"): Decorator => ({
      name: "relationship",
      args: [
        { key: "type", value: { kind: "string", value: rt.type } },
        { key: "direction", value: { kind: "identifier", value: direction } },
      ],
    });
    for (const { from, to } of pairs) {
      const outName = uniqueName(
        camel(rt.type) + (outTargets(from) > 1 ? to : ""),
        taken.get(from)!,
      );
      nodeFields.get(from)!.push({
        kind: "Relational",
        name: outName,
        target: to,
        cardinality: "many",
        optional: false,
        decorators: [relDecorator("OUT")],
      });
      const inName = uniqueName(
        `${camel(rt.type)}By${inSources(to) > 1 ? from : ""}`,
        taken.get(to)!,
      );
      nodeFields.get(to)!.push({
        kind: "Relational",
        name: inName,
        target: from,
        cardinality: "many",
        optional: false,
        decorators: [relDecorator("IN")],
      });
    }

    if (rt.properties.length === 0) continue;
    const props: ScalarNodeField[] = [];
    for (const p of [...rt.properties].sort((a, b) =>
      a.propertyName.localeCompare(b.propertyName),
    )) {
      const t = mapType(p.propertyTypes);
      if (!t || !IDENT.test(p.propertyName)) {
        warnings.push(`Skipped :${rt.type}.${p.propertyName}: unsupported type or name.`);
        continue;
      }
      const decorators: Decorator[] = [];
      if (relUnique.has(`${rt.type}.${p.propertyName}`)) decorators.push(dec("unique"));
      else if (indexOn.has(`RELATIONSHIP:${rt.type}.${p.propertyName}`))
        decorators.push(dec("index"));
      props.push({
        kind: "Scalar",
        name: p.propertyName,
        type: {
          name: t.name,
          optional: !p.mandatory && !t.list,
          ...(t.list ? { list: true } : {}),
        },
        decorators,
      });
    }
    for (const { from, to } of pairs) {
      let base = pascal(rt.type) + (pairs.length > 1 ? `${from}${to}` : "");
      if (declNames.has(base)) base += "Rel";
      relationships.push({
        kind: "Relationship",
        name: uniqueName(base, declNames),
        relType: rt.type,
        from,
        to,
        fields: props,
      });
    }
  }

  const nodes: NodeDeclaration[] = [...nodeFields].map(([name, fields]) => ({
    kind: "Node",
    name,
    fields,
  }));
  for (const n of nodes) {
    if (!n.fields.some((f) => f.kind === "Scalar")) {
      warnings.push(`Node ${n.name} has no properties in the database.`);
    }
  }
  return { doc: { kind: "Document", declarations: [...nodes, ...relationships] }, warnings };
}
