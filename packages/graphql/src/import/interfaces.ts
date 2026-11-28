/**
 * Shared labels and GraphQL interfaces to Cyphra interfaces.
 *
 * In `@neo4j/graphql` v7, `@node(labels: ["Lab", "LearningActivity"])` writes and matches every
 * label: a `Lab` is stored as `(:Lab:LearningActivity)`. A Cyphra interface is exactly that, a
 * label its implementations always carry, so a label shared by several `@node` types (or carried by
 * one) becomes `interface LearningActivity { … }` holding the fields its carriers have in common,
 * and each carrier `implements` it. When the carriers declare a common field differently, the
 * fields do not line up and the label becomes `@@labels([LearningActivity])` on each carrier
 * instead (a label Cyphra reads and filters on, but does not add on create). A field that differs
 * only in its `@default` (`kind: String! @default(value: "lab")` on one carrier, `"quiz"` on
 * another) does not prevent the interface: it stays on each implementation, with its own default
 * (an inherited field has a single declaration). A field that only
 * some carriers mark `@id` (`id: ID! @id` on one, a plain `id: ID!` on another) lines up: the
 * interface declares it `@id`, with `@default(uuid())` when one of them generated its values.
 *
 * A v7 GraphQL `interface` adds no label. It becomes a Cyphra interface (relationships to it
 * included) when every `@node` implementation already carries its name as a label, or, with
 * `addInterfaceLabels`, when the caller accepts that Cyphra needs the label on existing nodes (the
 * report gives the Cypher to add it).
 *
 * @packageDocumentation
 */

import {
  formatDecorator,
  type Decorator,
  type ModelAttribute,
  type NodeField,
  type ScalarNodeField,
} from "@cyphra/schema";
import { defaultFn, ID, type IssueDraft } from "./mappings.js";

/** A converted `@node` type, before printing. The interface pass moves fields out of it. */
export type NodeDraft = {
  /** Name of the GraphQL type. */
  readonly graphqlName: string;
  /** Name of the Cyphra node (its first label). */
  readonly name: string;
  fields: NodeField[];
  /** GraphQL field name → converted field (fields that were converted only). */
  readonly byGraphql: ReadonlyMap<string, NodeField>;
  /** Cyphra scalar field name → GraphQL type name (`ID`, `String`, …). */
  readonly graphqlTypeOf: ReadonlyMap<string, string>;
  /** Labels after the first in `@node(labels)` (identifiers only). */
  readonly extraLabels: readonly string[];
  /** GraphQL interfaces the type implements, in order. */
  readonly interfaces: readonly string[];
  /** Cyphra interfaces the node implements (filled by {@link mapInterfaces}). */
  readonly implements: string[];
  attributes: ModelAttribute[];
};

/** A Cyphra interface the pass created. */
export type InterfaceDraft = {
  readonly name: string;
  fields: NodeField[];
  attributes: ModelAttribute[];
  /** Implementations, in node order. */
  readonly members: readonly NodeDraft[];
  /** GraphQL field name → Cyphra field name, for the fields declared on the interface. */
  readonly hoisted: ReadonlyMap<string, string>;
  /** Cyphra scalar field name → GraphQL type name. */
  readonly graphqlTypeOf: ReadonlyMap<string, string>;
};

/** A GraphQL `interface` type. */
export type GraphQLInterfaceInfo = {
  readonly name: string;
  /** GraphQL field names, in order. */
  readonly fields: readonly string[];
  /** Type directives (none is converted on an interface). */
  readonly directives: readonly string[];
};

export type InterfacePassInput = {
  readonly nodes: readonly NodeDraft[];
  readonly graphqlInterfaces: readonly GraphQLInterfaceInfo[];
  /** Cyphra node names: a label named like one cannot be mapped. */
  readonly nodeNames: ReadonlySet<string>;
  /** Other names an interface cannot take (GraphQL enums, unions, …; Cyphra built-in types). */
  readonly takenNames: ReadonlySet<string>;
  /**
   * Why a field must stay on its node (a uniqueness constraint on the node's own label), or
   * `undefined` when it may move to an interface.
   */
  readonly pinned: (node: NodeDraft, graphqlField: string) => string | undefined;
  /** Map GraphQL interfaces whose implementations do not carry the label yet. */
  readonly addInterfaceLabels: boolean;
  readonly report: (at: string, d: IssueDraft) => void;
};

export type InterfacePassResult = {
  /** Interfaces created, in order. */
  readonly interfaces: readonly InterfaceDraft[];
  /** GraphQL interfaces that were not converted (relationships to them are not either). */
  readonly unconverted: ReadonlySet<string>;
  /** GraphQL node type → GraphQL field name → the interface now declaring it. */
  readonly hoisted: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

type Group = {
  readonly name: string;
  readonly graphql?: GraphQLInterfaceInfo;
  /** GraphQL node types carrying the label through `@node(labels)`. */
  readonly carriers: Set<string>;
  /** GraphQL node types implementing the GraphQL interface. */
  readonly implementers: Set<string>;
};

/** `title: String @unique` / `kind String @default("lab")` as one line, for the report. */
function show(f: NodeField): string {
  if (f.kind === "Relational") {
    const t = f.cardinality === "many" ? `${f.target}[]` : `${f.target}${f.optional ? "?" : ""}`;
    return `${f.name} ${t}`;
  }
  const t = `${f.type.enum ?? f.type.name}${f.type.list ? "[]" : f.type.optional ? "?" : ""}`;
  const decorators = f.decorators.map((d) => ` ${formatDecorator(d)}`).join("");
  return `${f.name} ${t}${decorators}`;
}

const same = (a: NodeField, b: NodeField): boolean => JSON.stringify(a) === JSON.stringify(b);

function hasId(f: NodeField): boolean {
  return f.kind === "Scalar" && f.decorators.some((d) => d.name === "id");
}

const UUID_DEFAULT = defaultFn("uuid");
const DECORATOR_ORDER = ["id", "unique", "index", "default"];
/** Decorators an identifier may differ by between implementations (and `@default(uuid())`). */
const ID_DECORATORS = new Set(["id", "unique"]);
const isUuidDefault = (d: Decorator): boolean =>
  d.name === "default" && JSON.stringify(d.args) === JSON.stringify(UUID_DEFAULT.args);

/** `f` without `@id`, `@unique` and `@default(uuid())`, to compare identifiers. */
function withoutIdDecorators(f: ScalarNodeField): ScalarNodeField {
  return {
    ...f,
    decorators: f.decorators.filter((d) => !ID_DECORATORS.has(d.name) && !isUuidDefault(d)),
  };
}

/**
 * An identifier only some members mark `@id` (v7 `@id` on one implementation, a plain or
 * constrained `ID!` on another): the field the interface declares instead (`@id`, plus
 * `@default(uuid())` when a member generated its values), or `undefined` when the fields differ
 * otherwise, or a member has its `@id` on another field.
 */
function mergedId(
  members: readonly NodeDraft[],
  graphqlField: string,
): { field: ScalarNodeField; plain: NodeDraft[]; generated: NodeDraft[] } | undefined {
  const fields = members.map((m) => m.byGraphql.get(graphqlField));
  if (!fields.every((f): f is ScalarNodeField => f?.kind === "Scalar")) return undefined;
  if (!fields.some(hasId)) return undefined;
  const base = withoutIdDecorators(fields[0]!);
  if (base.type.optional || base.type.list) return undefined;
  if (!fields.every((f) => same(withoutIdDecorators(f), base))) return undefined;
  if (members.some((m, i) => m.fields.some((x) => x !== fields[i] && hasId(x)))) return undefined;
  const generated = members.filter((_, i) => fields[i]!.decorators.some(isUuidDefault));
  const decorators = [ID, ...base.decorators, ...(generated.length ? [UUID_DEFAULT] : [])].sort(
    (x, y) => DECORATOR_ORDER.indexOf(x.name) - DECORATOR_ORDER.indexOf(y.name),
  );
  return {
    field: { ...base, decorators },
    plain: members.filter((_, i) => !hasId(fields[i]!)),
    generated,
  };
}

/** `f` without `@default`, to compare fields that may differ only by their default. */
function withoutDefault(f: ScalarNodeField): ScalarNodeField {
  return { ...f, decorators: f.decorators.filter((d) => d.name !== "default") };
}

/**
 * A scalar field the members declare alike but for its `@default`: each member's default
 * (`@default("lab")`, or `no default`), or `undefined` when the fields differ otherwise.
 */
function defaultsOnly(members: readonly NodeDraft[], graphqlField: string): string[] | undefined {
  const fields = members.map((m) => m.byGraphql.get(graphqlField));
  if (!fields.every((f): f is ScalarNodeField => f?.kind === "Scalar")) return undefined;
  const base = withoutDefault(fields[0]!);
  if (!fields.every((f) => same(withoutDefault(f), base))) return undefined;
  return fields.map((f) => {
    const d = f.decorators.find((x) => x.name === "default");
    return d ? formatDecorator(d) : "no default";
  });
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Map shared labels and GraphQL interfaces to Cyphra interfaces (or `@@labels`). Mutates the
 * nodes: moves the interface fields out of them, fills `implements` and adds `@@labels`.
 */
export function mapInterfaces(input: InterfacePassInput): InterfacePassResult {
  const { nodes, report } = input;
  const groups = new Map<string, Group>();
  const group = (name: string): Group => {
    let g = groups.get(name);
    if (!g) {
      const graphql = input.graphqlInterfaces.find((i) => i.name === name);
      g = { name, ...(graphql ? { graphql } : {}), carriers: new Set(), implementers: new Set() };
      groups.set(name, g);
    }
    return g;
  };
  // GraphQL interfaces first (in declaration order), then labels (in order of first carrier).
  for (const i of input.graphqlInterfaces) group(i.name);
  for (const n of nodes) {
    for (const i of n.interfaces) group(i).implementers.add(n.graphqlName);
  }
  for (const n of nodes) {
    for (const l of n.extraLabels) group(l).carriers.add(n.graphqlName);
  }

  const interfaces: InterfaceDraft[] = [];
  const unconverted = new Set<string>();
  const hoisted = new Map<string, Map<string, string>>();
  /** Cyphra field names each node inherits so far, and whether one of them is its @id. */
  const inherited = new Map<string, Set<string>>();
  const inheritsId = new Set<string>();
  const labelsOf = new Map<NodeDraft, string[]>();

  const addLabel = (n: NodeDraft, label: string) => {
    const labels = labelsOf.get(n) ?? [];
    labels.push(label);
    labelsOf.set(n, labels);
  };

  for (const g of groups.values()) {
    const members = nodes.filter(
      (n) => g.carriers.has(n.graphqlName) || g.implementers.has(n.graphqlName),
    );
    const carriers = members.filter((n) => g.carriers.has(n.graphqlName));
    const what = g.graphql ? "interface" : "@node(labels)";

    // The label (when nodes carry it) is kept as `@@labels` when no interface can be made.
    const fallback = (reason: string) => {
      if (g.graphql) {
        report(g.name, {
          severity: "unsupported",
          feature: "interface",
          message: `${reason}: not converted, nor the relationships to it; the implementations keep their own fields`,
        });
        unconverted.add(g.name);
      }
      for (const n of carriers) {
        addLabel(n, g.name);
        report(n.graphqlName, {
          severity: "changed",
          feature: "@node(labels)",
          message: `label "${g.name}" became @@labels([${g.name}]) (${g.graphql ? "see the interface's entry" : reason}): Cyphra matches ${n.name} nodes with or without it and does not add it on create; add it with \`$labels: { add: ["${g.name}"] }\``,
        });
      }
    };

    if (members.length === 0) {
      // A GraphQL interface no @node type implements (e.g. one for @cypher result types).
      report(g.name, {
        severity: "unsupported",
        feature: "interface",
        message: "no @node type implements it: not converted",
      });
      unconverted.add(g.name);
      continue;
    }
    if (input.nodeNames.has(g.name)) {
      for (const n of carriers) {
        report(n.graphqlName, {
          severity: "unsupported",
          feature: "@node(labels)",
          message: `label "${g.name}" is the label of node ${g.name}: a ${n.name} would also be read as a ${g.name}, which Cyphra cannot express; not converted`,
        });
      }
      continue;
    }
    if (input.takenNames.has(g.name)) {
      fallback(`"${g.name}" is already the name of a type`);
      continue;
    }
    for (const d of g.graphql?.directives ?? []) {
      report(g.name, {
        severity: "unsupported",
        feature: `@${d}`,
        message: `@${d} on an interface: not converted`,
      });
    }

    // Do the fields line up? Interface fields must be the same on every implementation; for a
    // label, every field the carriers have in common must be.
    const names: string[] = g.graphql
      ? g.graphql.fields.filter((f) => members.some((m) => m.byGraphql.has(f)))
      : members.length >= 2
        ? [...members[0]!.byGraphql.keys()].filter((f) => members.every((m) => m.byGraphql.has(f)))
        : [];
    let mismatch: string | undefined;
    /** Identifiers only some members mark `@id`: the field declared on the interface instead. */
    const merged = new Map<string, NonNullable<ReturnType<typeof mergedId>>>();
    /** Fields that differ only in their `@default`: kept on each member, with its default. */
    const ownDefaults = new Map<string, string[]>();
    for (const f of names) {
      const missing = members.find((m) => !m.byGraphql.has(f));
      if (missing) {
        mismatch = `${missing.graphqlName} has no converted field "${f}"`;
        break;
      }
      const first = members[0]!.byGraphql.get(f)!;
      const other = members.find((m) => !same(m.byGraphql.get(f)!, first));
      const id = other ? mergedId(members, f) : undefined;
      if (id) {
        merged.set(f, id);
        continue;
      }
      const defaults = other ? defaultsOnly(members, f) : undefined;
      if (defaults) {
        ownDefaults.set(f, defaults);
        continue;
      }
      if (other) {
        mismatch = `field "${f}" differs: ${members[0]!.graphqlName} has \`${show(first)}\`, ${other.graphqlName} has \`${show(other.byGraphql.get(f)!)}\``;
        break;
      }
    }
    if (mismatch) {
      fallback(`the fields do not line up: ${mismatch}`);
      continue;
    }
    const unlabelled = g.graphql ? members.filter((m) => !g.carriers.has(m.graphqlName)) : [];
    if (unlabelled.length && !input.addInterfaceLabels) {
      fallback(
        `v7 interfaces add no label and ${list(unlabelled.map((m) => m.graphqlName))} ${unlabelled.length > 1 ? "do" : "does"} not carry "${g.name}" through @node(labels); pass --add-interface-labels to map it to a Cyphra interface (the label must then be added to the existing nodes)`,
      );
      continue;
    }

    // Fields to declare on the interface.
    const fields: NodeField[] = [];
    const moved = new Map<string, string>();
    const graphqlTypeOf = new Map<string, string>();
    const kept: string[] = [];
    const idNotes: string[] = [];
    for (const f of names) {
      const defaults = ownDefaults.get(f);
      if (defaults) {
        const each = members.map((m, i) => `${m.graphqlName} ${defaults[i]}`);
        kept.push(`${f} (its @default differs: ${list(each)})`);
        continue;
      }
      const field = merged.get(f)?.field ?? members[0]!.byGraphql.get(f)!;
      if (members.some((m) => hoisted.get(m.graphqlName)?.has(f))) continue;
      if (members.some((m) => inherited.get(m.graphqlName)?.has(field.name))) continue;
      const pin = members.map((m) => input.pinned(m, f)).find(Boolean);
      if (pin) {
        kept.push(`${f} (${pin})`);
        continue;
      }
      if (hasId(field) && members.some((m) => inheritsId.has(m.graphqlName))) {
        kept.push(`${f} (another interface of a member already has the @id)`);
        continue;
      }
      fields.push(field);
      moved.set(f, field.name);
      const id = merged.get(f);
      if (id) {
        const marked = members.filter((m) => !id.plain.includes(m)).map((m) => m.graphqlName);
        const plain = id.plain.map((m) => m.graphqlName);
        const notGenerated = members.filter((m) => !id.generated.includes(m));
        idNotes.push(
          `${f} is @id on ${list(marked)} but not on ${list(plain)}: the interface declares it @id${id.generated.length ? " @default(uuid())" : ""}, so the ${f} values of ${list(plain)} must be unique across :${g.name} nodes too` +
            (id.generated.length && notGenerated.length
              ? `, and ${list(notGenerated.map((m) => m.graphqlName))} now ${notGenerated.length > 1 ? "get" : "gets"} a generated ${f} when the application gives none (an inherited field has a single declaration, so the default cannot stay on ${list(id.generated.map((m) => m.graphqlName))} only)`
              : ""),
        );
      }
      const t = members[0]!.graphqlTypeOf.get(field.name);
      if (t) graphqlTypeOf.set(field.name, t);
    }

    const decl: InterfaceDraft = {
      name: g.name,
      fields,
      attributes: [],
      members,
      hoisted: moved,
      graphqlTypeOf,
    };
    interfaces.push(decl);
    for (const m of members) {
      m.implements.push(g.name);
      const fieldsOfMember = new Set([...moved.keys()].map((f) => m.byGraphql.get(f)!));
      m.fields = m.fields.filter((f) => !fieldsOfMember.has(f));
      const h = hoisted.get(m.graphqlName) ?? new Map<string, string>();
      for (const f of moved.keys()) h.set(f, g.name);
      hoisted.set(m.graphqlName, h);
      const inh = inherited.get(m.graphqlName) ?? new Set<string>();
      for (const f of fields) inh.add(f.name);
      inherited.set(m.graphqlName, inh);
      if (fields.some(hasId)) inheritsId.add(m.graphqlName);
    }

    const memberNames = list(members.map((m) => m.name));
    const declared = fields.length
      ? `declares ${members.length > 1 ? "their common" : "the"} field${fields.length > 1 ? "s" : ""} ${list(fields.map((f) => f.name))}`
      : "declares no field";
    const constrained = fields.filter(
      (f) =>
        f.kind === "Scalar" && f.decorators.some((d) => d.name === "id" || d.name === "unique"),
    );
    const carried =
      members.length > 1 ? `label shared by ${memberNames}` : `label of ${memberNames}`;
    const parts = [
      !g.graphql
        ? `${carried}: mapped to interface ${g.name} (Cyphra writes and matches the label, like v7); it ${declared}`
        : unlabelled.length
          ? `mapped to interface ${g.name}, implemented by ${memberNames}; it ${declared}`
          : `mapped to interface ${g.name}, implemented by ${memberNames}, which carry its label through @node(labels) (Cyphra writes and matches it, like v7); it ${declared}`,
    ];
    if (constrained.length) {
      parts.push(
        `the uniqueness of ${list(constrained.map((f) => f.name))} now spans every :${g.name} node (one constraint on :${g.name} instead of one per label)`,
      );
    }
    parts.push(...idNotes);
    if (kept.length) parts.push(`kept on each implementation: ${kept.join(", ")}`);
    report(g.name, { severity: "changed", feature: what, message: parts.join("; ") });
    for (const m of unlabelled) {
      const match = [m.name, ...m.extraLabels].join(":");
      report(m.graphqlName, {
        severity: "changed",
        feature: "interface",
        message: `implements ${g.name}, a label v7 does not write: add it to the existing nodes before reading them through Cyphra (\`MATCH (n:${match}) SET n:${g.name}\`, or a migration)`,
      });
    }
  }

  for (const [n, labels] of labelsOf) {
    n.attributes = [
      ...n.attributes,
      { kind: "ModelAttribute", name: "labels", fields: labels, args: [] },
    ];
  }
  return { interfaces, unconverted, hoisted };
}
