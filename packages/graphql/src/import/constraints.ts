/**
 * Uniqueness from the database (or from hints) to `@id` / `@unique`.
 *
 * `@neo4j/graphql` v7 type definitions do not say which fields are unique: `id: ID!` may be backed
 * by a uniqueness constraint in the database, or not. Given the database's uniqueness constraints
 * (read by `cyphra import graphql --url`) or `Type.field` hints (`--id-fields`), the fields they
 * cover are marked: an `ID` field (or a hinted one) becomes the node's `@id`, any other field
 * `@unique`, and a constraint over several properties `@@unique([…])`. No default is added: the
 * values come from the application, as they did with v7.
 *
 * @packageDocumentation
 */

import type { Decorator, NodeField, ScalarNodeField } from "@cyphra/schema";
import type { IssueDraft } from "./mappings.js";
import type { InterfaceDraft, NodeDraft } from "./interfaces.js";

/** A node uniqueness constraint (or node key) of the database. */
export type UniquenessConstraint = {
  /** Constraint name in the database. */
  readonly name: string;
  readonly label: string;
  readonly properties: readonly string[];
  /** `UNIQUE`, or `KEY` for a node key (the properties are also required). */
  readonly type: "UNIQUE" | "KEY";
};

/** A constraint or a hint, resolved to a label and Cyphra property names. */
type Backing = {
  readonly label: string;
  readonly properties: readonly string[];
  /** How the report names it. */
  readonly source: string;
  readonly hint: boolean;
};

const DECORATOR_ORDER = ["id", "unique", "index", "default"];
const ID: Decorator = { name: "id", args: [] };
const UNIQUE: Decorator = { name: "unique", args: [] };

type Report = (at: string, d: IssueDraft) => void;

/**
 * Resolve the constraints and `Type.field` hints to backings. A hint names a GraphQL `@node` type,
 * or a shared label / GraphQL interface name, and a GraphQL field name.
 */
export function resolveBackings(
  nodes: readonly NodeDraft[],
  constraints: readonly UniquenessConstraint[],
  hints: readonly string[],
  groupNames: ReadonlySet<string>,
  report: Report,
): Backing[] {
  const out: Backing[] = constraints.map((c) => ({
    label: c.label,
    properties: c.properties,
    source: `${c.type === "KEY" ? "node key" : "uniqueness constraint"} ${c.name}`,
    hint: false,
  }));
  for (const raw of hints) {
    const hint = raw.trim();
    if (!hint) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(hint);
    const at = m ? hint : "--id-fields";
    const fail = (why: string) =>
      report(at, { severity: "unsupported", feature: "--id-fields", message: `${why}: ignored` });
    if (!m) {
      fail(`"${hint}" is not Type.field`);
      continue;
    }
    const [, type, field] = m as unknown as [string, string, string];
    const node = nodes.find((n) => n.graphqlName === type);
    const owners = node
      ? [node]
      : groupNames.has(type)
        ? nodes.filter((n) => n.extraLabels.includes(type) || n.interfaces.includes(type))
        : [];
    if (owners.length === 0) {
      fail(`"${type}" is not a converted @node type, shared label or interface`);
      continue;
    }
    const f = owners.map((o) => o.byGraphql.get(field)).find(Boolean);
    if (!f || f.kind !== "Scalar") {
      fail(`"${type}" has no converted scalar field "${field}"`);
      continue;
    }
    out.push({
      label: node ? node.name : type,
      properties: [f.name],
      source: "--id-fields",
      hint: true,
    });
  }
  return out;
}

/**
 * Why a field of a node must stay on it (a single-property backing on the node's own label), for
 * the interface pass.
 */
export function pinnedBy(
  backings: readonly Backing[],
): (node: NodeDraft, graphqlField: string) => string | undefined {
  return (node, graphqlField) => {
    const f = node.byGraphql.get(graphqlField);
    if (!f || f.kind !== "Scalar") return undefined;
    const b = backings.find(
      (x) => x.label === node.name && x.properties.length === 1 && x.properties[0] === f.name,
    );
    return b ? `${b.source} is on :${node.name}` : undefined;
  };
}

/** How the report and `--id-fields` name a declaration's field: GraphQL type and field names. */
function graphqlAt(decl: NodeDraft | InterfaceDraft, field?: string): string {
  const type = "graphqlName" in decl ? decl.graphqlName : decl.name;
  if (field === undefined) return type;
  const names =
    "byGraphql" in decl ? [...decl.byGraphql] : [...decl.hoisted].map(([g, c]) => [g, c]);
  const g = names.find(([, f]) => (typeof f === "string" ? f : f.name) === field)?.[0];
  return `${type}.${g ?? field}`;
}

const isScalar = (f: NodeField | undefined): f is ScalarNodeField => f?.kind === "Scalar";
const hasDecorator = (f: NodeField, name: string) =>
  f.kind === "Scalar" && f.decorators.some((d) => d.name === name);

/**
 * Mark the fields the backings cover, and report each decision. With `fromDatabase`, also report
 * the `ID` fields no constraint covers.
 */
export function applyBackings(
  backings: readonly Backing[],
  nodes: readonly NodeDraft[],
  interfaces: readonly InterfaceDraft[],
  opts: {
    readonly fromDatabase: boolean;
    /** Labels mapped to `@@labels` or not converted. */
    readonly unmappedLabels: ReadonlySet<string>;
    readonly report: Report;
  },
): void {
  const { report } = opts;
  const ifaceByName = new Map(interfaces.map((i) => [i.name, i]));
  const nodeByName = new Map(nodes.map((n) => [n.name, n]));
  const marked = new Set<NodeField>();

  /** Fields of a node or interface, inherited ones included. */
  const allFields = (decl: NodeDraft | InterfaceDraft): NodeField[] =>
    "implements" in decl
      ? [...decl.implements.flatMap((i) => ifaceByName.get(i)?.fields ?? []), ...decl.fields]
      : decl.fields;
  /** Whether another field than `f` is an `@id` for `decl` (its interfaces and members included). */
  const idElsewhere = (decl: NodeDraft | InterfaceDraft, f: NodeField): boolean => {
    const scope: NodeField[] =
      "implements" in decl
        ? allFields(decl)
        : [
            ...decl.fields,
            ...decl.members.flatMap((m) => allFields(m)).filter((x) => !decl.fields.includes(x)),
          ];
    return scope.some((x) => x !== f && hasDecorator(x, "id"));
  };

  for (const b of backings) {
    const decl = nodeByName.get(b.label) ?? ifaceByName.get(b.label);
    const target = `:${b.label}(${b.properties.join(", ")})`;
    if (!decl) {
      if (opts.unmappedLabels.has(b.label)) {
        report(b.label, {
          severity: "unsupported",
          feature: b.hint ? "--id-fields" : "constraint",
          message: `${b.source} on ${target}: the label is not an interface (see its entry), so the field is not marked`,
        });
      } else if (b.hint) {
        report(b.label, {
          severity: "unsupported",
          feature: "--id-fields",
          message: `${b.label} is not a converted node or interface: ignored`,
        });
      }
      // Constraints on labels the type definitions do not use belong to other applications.
      continue;
    }
    const where = graphqlAt(decl);
    if (b.properties.length > 1) {
      const fields = allFields(decl);
      const bad = b.properties.find((p) => {
        const f = fields.find((x) => x.name === p);
        return !isScalar(f) || f.type.list || f.type.name === "Json" || f.type.name === "Vector";
      });
      if (bad) {
        report(where, {
          severity: "unsupported",
          feature: "constraint",
          message: `${b.source} on ${target}: "${bad}" is not a single-value scalar field; not converted`,
        });
        continue;
      }
      const key = JSON.stringify([...b.properties].sort());
      if (
        decl.attributes.some(
          (a) => a.name === "unique" && JSON.stringify([...(a.fields ?? [])].sort()) === key,
        )
      ) {
        continue;
      }
      decl.attributes = [
        ...decl.attributes,
        { kind: "ModelAttribute", name: "unique", fields: [...b.properties], args: [] },
      ];
      report(where, {
        severity: "changed",
        feature: "constraint",
        message: `${b.source} on ${target}: became @@unique([${b.properties.join(", ")}])`,
      });
      continue;
    }

    const prop = b.properties[0]!;
    const index = decl.fields.findIndex((x) => x.name === prop);
    const field = decl.fields[index];
    const at = graphqlAt(decl, prop);
    if (!isScalar(field)) {
      const inheritedFrom =
        "implements" in decl
          ? decl.implements.find((i) => ifaceByName.get(i)?.fields.some((x) => x.name === prop))
          : undefined;
      report(at, {
        severity: "unsupported",
        feature: b.hint ? "--id-fields" : "constraint",
        message: inheritedFrom
          ? `${b.source} on ${target}, but the field is declared on interface ${inheritedFrom}: not marked (the constraint would move to :${inheritedFrom})`
          : `${b.source} on ${target}: ${decl.name} has no scalar field "${prop}"; not converted`,
      });
      continue;
    }
    if (marked.has(field)) continue;
    if (hasDecorator(field, "id") || hasDecorator(field, "unique")) {
      marked.add(field);
      report(at, {
        severity: "changed",
        feature: b.hint ? "--id-fields" : "constraint",
        message: `already ${hasDecorator(field, "id") ? "@id" : "@unique"}; ${b.source} backs it`,
      });
      continue;
    }
    if (field.type.list) {
      report(at, {
        severity: "unsupported",
        feature: b.hint ? "--id-fields" : "constraint",
        message: `${b.source} on ${target}: a list field cannot be @id or @unique; not marked`,
      });
      continue;
    }
    const graphqlType = decl.graphqlTypeOf.get(prop);
    const wantsId = b.hint || graphqlType === "ID";
    const canId = !field.type.optional && !idElsewhere(decl, field);
    const decorator = wantsId && canId ? ID : UNIQUE;
    const why =
      wantsId && !canId
        ? field.type.optional
          ? " (the field is optional, an @id cannot be)"
          : " (it already has an @id)"
        : "";
    const decorators = [...field.decorators, decorator].sort(
      (x, y) => DECORATOR_ORDER.indexOf(x.name) - DECORATOR_ORDER.indexOf(y.name),
    );
    const next: ScalarNodeField = { ...field, decorators };
    decl.fields[index] = next;
    marked.add(next);
    report(at, {
      severity: "changed",
      feature: b.hint ? "--id-fields" : "constraint",
      message: `${b.hint ? "hinted with --id-fields" : `${b.source} on ${target}`}: marked @${decorator.name}${why}${decorator === ID ? "; no default: the application gives the value, as with v7" : ""}`,
    });
  }

  if (!opts.fromDatabase) return;
  for (const decl of [...interfaces, ...nodes]) {
    for (const f of decl.fields) {
      if (!isScalar(f) || decl.graphqlTypeOf.get(f.name) !== "ID" || f.type.list) continue;
      if (hasDecorator(f, "id") || hasDecorator(f, "unique")) continue;
      const at = graphqlAt(decl, f.name);
      report(at, {
        severity: "changed",
        feature: "constraint",
        message: `no uniqueness constraint on :${decl.name}(${f.name}) in the database: kept as a plain String (pass --id-fields ${at} to mark it @id)`,
      });
    }
  }
}
