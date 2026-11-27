/**
 * The operation codemod: v7 operation documents → native ones, following the mapping table of the
 * native API docs. Each document is translated as a whole or left as it is: an operation with a
 * construct that has no native equivalent (a filter on edge properties, a nested write by a
 * non-unique `where`, a variable holding a v7 input) is reported and not rewritten, so the
 * codemod never changes what an operation means without saying so.
 *
 * Every translation also returns how to map the v7 result of the operation to the shape of the
 * native result (`compare` runs both and diffs them).
 *
 * @packageDocumentation
 */

import {
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  Kind,
  NoUnusedFragmentsRule,
  parse,
  parseType,
  print,
  specifiedRules,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
  type ArgumentNode,
  type DefinitionNode,
  type DirectiveNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLError,
  type GraphQLInputType,
  type OperationDefinitionNode,
  type SelectionNode,
  type SelectionSetNode,
  type TypeNode,
  type VariableDefinitionNode,
} from "graphql";
import type { ResolvedScalarField } from "@cyphra/schema";
import { isInterface, type NodeType, type Relationship } from "../v7/model.js";
import type { MigrationContext } from "./context.js";
import { Issues, WhereTranslator, type MigrationIssue } from "./where.js";
import {
  field,
  fromAst,
  get,
  isObj,
  list,
  obj,
  toAst,
  type Field,
  type ObjValue,
  type Value,
} from "./value.js";

/** A value of a v7 result the native result cannot be compared with (e.g. a cursor). */
export class Unmapped {
  constructor(readonly reason: string) {}
}

/** Maps a v7 value to the native shape. */
type MapFn = (v7: unknown) => unknown;

/** What happened to one document. */
export type DocumentStatus =
  /** Rewritten into a native document. */
  | "translated"
  /** Left as it is: something in it has no native equivalent (see `issues`). */
  | "blocked"
  /** Already a native document (it validates against the native schema, not the v7 one). */
  | "native"
  /** Neither a v7 nor a native document (syntax or validation errors). */
  | "invalid";

/** One operation or fragment of a translated document. */
export type DefinitionTranslation = {
  readonly kind: "operation" | "fragment";
  /** The operation's or fragment's name. */
  readonly name?: string;
  /** Offset of the definition in the document. */
  readonly loc: number;
  readonly issues: readonly MigrationIssue[];
  /**
   * For an operation that was translated: maps the v7 `data` to the native shape (values that
   * cannot be compared, such as cursors, are {@link Unmapped}).
   */
  readonly mapData?: (data: Record<string, unknown>) => Record<string, unknown>;
};

/** The translation of one document. */
export type DocumentTranslation = {
  readonly status: DocumentStatus;
  /** The document as it should now read (`source` itself when nothing changed). */
  readonly output: string;
  /** Whether `output` differs from the source. */
  readonly changed: boolean;
  readonly definitions: readonly DefinitionTranslation[];
  /** Every issue of the document (also per definition). */
  readonly issues: readonly MigrationIssue[];
};

/** Options of {@link translateDocument}. */
export type TranslateOptions = {
  /**
   * Write a `# cyphra: …` comment above each definition with issues (default `true`): what kept it
   * from being translated, or what the translation lost.
   */
  readonly comments?: boolean;
};

type NativeType = { getFields(): Record<string, unknown> } | undefined;

/** One field of a native selection being built, before its response key is chosen. */
type Item = {
  /** Native field name. */
  readonly name: string;
  /** The alias the v7 selection had. */
  readonly alias?: string;
  /** The response key in the v7 result the value comes from. */
  readonly v7Key: string;
  readonly args: readonly ArgumentNode[];
  readonly directives: readonly DirectiveNode[];
  readonly selections?: readonly SelectionNode[];
  /** v7 value at `v7Key` → native value (identity when absent). */
  readonly map?: MapFn;
};

/** A `_count` entry: the number of related nodes, read from the v7 result. */
type CountItem = {
  readonly rel: string;
  readonly where?: Value;
  readonly v7Key: string;
  readonly read: MapFn;
};

/** A translated selection set: native selections and the mapping of a v7 object to them. */
type Selection = {
  readonly selections: SelectionNode[];
  readonly map: (v7: Record<string, unknown>) => Record<string, unknown>;
};

const NAME = (value: string) => ({ kind: Kind.NAME, value }) as const;

function arg(name: string, value: Value): ArgumentNode {
  return { kind: Kind.ARGUMENT, name: NAME(name), value: toAst(value) };
}

function fieldNode(
  name: string,
  alias: string | undefined,
  args: readonly ArgumentNode[],
  selections?: readonly SelectionNode[],
  directives: readonly DirectiveNode[] = [],
): FieldNode {
  return {
    kind: Kind.FIELD,
    name: NAME(name),
    alias: alias && alias !== name ? NAME(alias) : undefined,
    arguments: args,
    directives,
    selectionSet: selections ? { kind: Kind.SELECTION_SET, selections } : undefined,
  };
}

const mapList =
  (f: MapFn): MapFn =>
  (v) =>
    Array.isArray(v) ? v.map(f) : v === null || v === undefined ? v : f(v);

function rec(v: unknown): Record<string, unknown> {
  return (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
}

const SORT_DIRECTIONS: Record<string, string> = { ASC: "asc", DESC: "desc" };

/** Translates the definitions of one document. */
class DocumentTranslator {
  readonly where: WhereTranslator;
  /** Mappers of the document's fragments, by name (filled as they are translated). */
  private readonly fragmentMaps = new Map<string, Selection["map"]>();
  private readonly fragments: Map<string, FragmentDefinitionNode>;
  /** The definition being translated, for its issues. */
  issues = new Issues();

  constructor(
    readonly ctx: MigrationContext,
    readonly doc: DocumentNode,
  ) {
    this.where = new WhereTranslator(ctx, this.issues);
    this.fragments = new Map(
      doc.definitions
        .filter((d): d is FragmentDefinitionNode => d.kind === Kind.FRAGMENT_DEFINITION)
        .map((d) => [d.name.value, d]),
    );
  }

  /** Start collecting the issues of another definition. */
  reset(): Issues {
    this.issues = new Issues();
    (this.where as { issues: Issues }).issues = this.issues;
    return this.issues;
  }

  private nativeType(v7Type: string): NativeType {
    const name = this.ctx.nativeModel(v7Type)?.name ?? v7Type;
    return this.ctx.nativeSchema.getType(name) as NativeType;
  }

  private nativeName(v7Type: string): string {
    return this.ctx.nativeModel(v7Type)?.name ?? v7Type;
  }

  // ---------------------------------------------------------------- selections on node types

  /**
   * A selection on a v7 `@node` type, interface or union → the selection on its native type
   * (scalars, relations, connections as relations with `_edge` and `_count`, fragments).
   */
  nodeSelection(set: SelectionSetNode | undefined, v7Type: string, at: string): Selection {
    const items: Item[] = [];
    const counts: CountItem[] = [];
    const others: { node: SelectionNode; map: Selection["map"] }[] = [];
    const node = this.ctx.v7Node(v7Type);
    const native = this.nativeType(v7Type);
    if (!native) {
      this.issues.block(`${at}: ${v7Type} ${missingModel(this.ctx, v7Type)}`, set?.loc?.start);
      return { selections: [], map: () => ({}) };
    }
    for (const s of set?.selections ?? []) {
      if (s.kind === Kind.INLINE_FRAGMENT) {
        const cond = s.typeCondition?.name.value ?? v7Type;
        const sub = this.nodeSelection(s.selectionSet, cond, `${at}(... on ${cond})`);
        others.push({
          node: {
            ...s,
            typeCondition: s.typeCondition
              ? { kind: Kind.NAMED_TYPE, name: NAME(this.nativeName(cond)) }
              : undefined,
            selectionSet: { kind: Kind.SELECTION_SET, selections: sub.selections },
          },
          map: sub.map,
        });
        continue;
      }
      if (s.kind === Kind.FRAGMENT_SPREAD) {
        const name = s.name.value;
        others.push({
          node: s,
          map: (v) => (this.fragmentMaps.get(name) ?? (() => ({})))(v),
        });
        continue;
      }
      const name = s.name.value;
      const key = s.alias?.value ?? name;
      const here = `${at}.${key}`;
      const loc = s.loc?.start;
      if (name === "__typename") {
        items.push({
          name,
          alias: s.alias?.value,
          v7Key: key,
          args: [],
          directives: s.directives ?? [],
          map: (v) => (typeof v === "string" ? this.nativeName(v) : v),
        });
        continue;
      }
      if (!node) {
        this.issues.block(`${here}: ${v7Type} has no field ${name} (select it in a fragment)`, loc);
        continue;
      }
      const attr = node.attributes.find((a) => a.name === name);
      if (attr) {
        const nativeName = this.ctx.nativeScalar(v7Type, attr)?.name ?? attr.name;
        if (!native?.getFields()[nativeName]) {
          this.issues.add(
            "note",
            attr.cypher
              ? `${here}: dropped: the @cypher field ${v7Type}.${name} is not in the native API (declare it in cypherFields)`
              : `${here}: dropped: ${v7Type}.${name} is not in the native API`,
            loc,
          );
          continue;
        }
        items.push({
          name: nativeName,
          alias: s.alias?.value ?? (nativeName !== name ? name : undefined),
          v7Key: key,
          args: s.arguments ?? [],
          directives: s.directives ?? [],
        });
        continue;
      }
      const cypherNode = node.cypherNodes.find((c) => c.name === name);
      const userField = node.userFields.find((u) => u.name === name);
      if (cypherNode || userField) {
        if (!native?.getFields()[name]) {
          this.issues.add(
            "note",
            `${here}: dropped: ${cypherNode ? "the @cypher field" : "the custom resolver field"} ${v7Type}.${name} is not in the native API (${cypherNode ? "declare it in cypherFields" : "add it with extend"})`,
            loc,
          );
          continue;
        }
        const target = cypherNode?.target;
        const sub =
          target && s.selectionSet ? this.nodeSelection(s.selectionSet, target, here) : undefined;
        items.push({
          name,
          alias: s.alias?.value,
          v7Key: key,
          args: s.arguments ?? [],
          directives: s.directives ?? [],
          selections: sub ? sub.selections : s.selectionSet?.selections,
          map: sub ? mapList((v) => sub.map(rec(v))) : undefined,
        });
        continue;
      }
      const rel = node.relationships.find((r) => r.name === name);
      if (rel) {
        const item = this.relationField(node, rel, s, here);
        if (item) items.push(item);
        continue;
      }
      const conn = node.relationships.find((r) => `${r.name}Connection` === name);
      if (conn) {
        const out = this.connectionField(node, conn, s, here);
        if (out.item) items.push(out.item);
        counts.push(...out.counts);
        continue;
      }
      this.issues.block(`${here}: unknown field ${v7Type}.${name}`, loc);
    }
    return this.finish(items, counts, others, set);
  }

  /** Choose response keys (aliasing renamed fields that would collide), add `_count`, map. */
  private finish(
    items: readonly Item[],
    counts: readonly CountItem[],
    others: readonly { node: SelectionNode; map: Selection["map"] }[],
    set: SelectionSetNode | undefined,
  ): Selection {
    const v7Keys = new Set(
      (set?.selections ?? [])
        .filter((s): s is FieldNode => s.kind === Kind.FIELD)
        .map((f) => f.alias?.value ?? f.name.value),
    );
    const used = new Map<string, string>();
    const selections: SelectionNode[] = [];
    const maps: ((v7: Record<string, unknown>, out: Record<string, unknown>) => void)[] = [];
    for (const it of items) {
      let key = it.alias ?? it.name;
      const signature = print(fieldNode(it.name, undefined, it.args, it.selections));
      if (
        (it.alias === undefined && key !== it.v7Key && v7Keys.has(key)) ||
        (used.has(key) && used.get(key) !== signature)
      ) {
        key = it.v7Key;
      }
      used.set(key, signature);
      selections.push(fieldNode(it.name, key, it.args, it.selections, it.directives));
      const map = it.map;
      maps.push((v7, out) => {
        if (!(it.v7Key in v7)) return;
        const v = v7[it.v7Key];
        out[key] = map ? map(v) : v;
      });
    }
    if (counts.length) {
      const names = counts.map((c) => c.rel);
      const countSelections = counts.map((c) => {
        const key = names.filter((n) => n === c.rel).length > 1 ? c.v7Key : c.rel;
        return {
          key,
          node: fieldNode(c.rel, key, c.where ? [arg("where", c.where)] : []),
          c,
        };
      });
      selections.push(
        fieldNode(
          "_count",
          undefined,
          [],
          countSelections.map((x) => x.node),
        ),
      );
      maps.push((v7, out) => {
        const count = (out._count ?? {}) as Record<string, unknown>;
        let any = false;
        for (const { key, c } of countSelections) {
          if (!(c.v7Key in v7)) continue;
          count[key] = c.read(v7[c.v7Key]);
          any = true;
        }
        if (any) out._count = count;
      });
    }
    for (const o of others) {
      selections.push(o.node);
      maps.push((v7, out) => Object.assign(out, o.map(v7)));
    }
    if (!selections.length) {
      if (set?.selections.length && !this.issues.blocked) {
        this.issues.block("nothing selected here has a native equivalent", set.loc?.start);
      }
      selections.push(fieldNode("__typename", undefined, []));
    }
    return {
      selections,
      map: (v7) => {
        const out: Record<string, unknown> = {};
        for (const m of maps) m(v7, out);
        return out;
      },
    };
  }

  /** `actors(where, sort, limit, offset) { … }` → `actors(where, orderBy, take, skip) { … }`. */
  private relationField(
    node: NodeType,
    rel: Relationship,
    s: FieldNode,
    at: string,
  ): Item | undefined {
    const name = this.relationName(node, rel, at, s.loc?.start);
    if (!name) return undefined;
    const args: ArgumentNode[] = [];
    for (const a of s.arguments ?? []) {
      const v = fromAst(a.value);
      const here = `${at}(${a.name.value})`;
      if (!rel.list) {
        this.issues.block(
          `${here}: the native API takes no arguments on a to-one relation`,
          a.loc?.start,
        );
        continue;
      }
      if (a.name.value === "where") args.push(arg("where", this.where.where(rel.target, v, here)));
      else if (a.name.value === "sort") {
        const o = this.orderBy(rel.target, v, here, false);
        if (o) args.push(arg("orderBy", o));
      } else if (a.name.value === "limit") this.take(args, v, here);
      else if (a.name.value === "offset") args.push(arg("skip", v));
      else this.issues.block(`${here}: unknown argument`, a.loc?.start);
    }
    const sub = this.nodeSelection(s.selectionSet, rel.target, at);
    return {
      name,
      alias: s.alias?.value,
      v7Key: s.alias?.value ?? s.name.value,
      args,
      directives: s.directives ?? [],
      selections: sub.selections,
      map: mapList((v) => sub.map(rec(v))),
    };
  }

  /** v7 `limit` → `take`; v7 ignores `limit: 0` (every node), native `take: 0` returns none. */
  private take(args: ArgumentNode[], v: Value, at: string): void {
    if (v.k === "number" && v.raw === "0") {
      this.issues.add(
        "note",
        `${at}: dropped: v7 ignores limit: 0 (native take: 0 returns no node)`,
        v.loc,
      );
      return;
    }
    if (v.k === "var") {
      this.issues.add(
        "known",
        `${at}: v7 ignores a limit of 0, native take: 0 returns no node`,
        v.loc,
        true,
      );
    }
    args.push(arg("take", v));
  }

  private relationName(
    node: NodeType,
    rel: Relationship,
    at: string,
    loc?: number,
  ): string | undefined {
    const r = this.ctx.nativeRelation(node.name, rel);
    if (!r) {
      this.issues.block(
        `${at}: ${node.name}.${rel.name} is not a relation of the Cyphra model`,
        loc,
      );
      return undefined;
    }
    return r.name;
  }

  /**
   * `actorsConnection(where, sort, first) { totalCount edges { properties node } }` →
   * `actors(where, orderBy, take) { … _edge { … } }` and `_count { actors(where) }`.
   */
  private connectionField(
    node: NodeType,
    rel: Relationship,
    s: FieldNode,
    at: string,
  ): { item?: Item; counts: CountItem[] } {
    const counts: CountItem[] = [];
    const name = this.relationName(node, rel, at, s.loc?.start);
    if (!name) return { counts };
    const v7Key = s.alias?.value ?? s.name.value;
    let where: Value | undefined;
    const args: ArgumentNode[] = [];
    for (const a of s.arguments ?? []) {
      const v = fromAst(a.value);
      const here = `${at}(${a.name.value})`;
      if (a.name.value === "where") {
        where = this.where.where(rel.target, this.connectionNodeWhere(rel, v, here), here);
        if (rel.list) args.push(arg("where", where));
        else
          this.issues.block(
            `${here}: the native API takes no where on a to-one relation`,
            a.loc?.start,
          );
      } else if (a.name.value === "sort") {
        const o = this.orderBy(rel.target, v, here, true);
        if (o && rel.list) args.push(arg("orderBy", o));
      } else if (a.name.value === "first") {
        if (rel.list) args.push(arg("take", v));
      } else if (a.name.value === "after") {
        this.issues.block(
          `${here}: relation lists have no cursors in the native API (page them with skip / take)`,
          a.loc?.start,
        );
      } else this.issues.block(`${here}: unknown argument`, a.loc?.start);
    }
    let nodeSel: SelectionSetNode | undefined;
    let edgeSel: FieldNode | undefined;
    let hasEdges = false;
    for (const c of s.selectionSet?.selections ?? []) {
      if (c.kind !== Kind.FIELD) {
        this.issues.block(
          `${at}: fragments on connection types cannot be translated`,
          c.loc?.start,
        );
        continue;
      }
      const here = `${at}.${c.name.value}`;
      switch (c.name.value) {
        case "edges": {
          if (c.alias) {
            this.issues.block(`${here}: aliased edges cannot be translated`, c.loc?.start);
            break;
          }
          hasEdges = true;
          for (const e of c.selectionSet?.selections ?? []) {
            if (e.kind !== Kind.FIELD || e.alias) {
              this.issues.block(
                `${here}: fragments and aliases on edges cannot be translated`,
                e.loc?.start,
              );
              continue;
            }
            if (e.name.value === "node") nodeSel = mergeSets(nodeSel, e.selectionSet);
            else if (e.name.value === "properties") edgeSel = e;
            else if (e.name.value === "cursor")
              this.issues.add(
                "note",
                `${here}.cursor: dropped: relation lists have no cursors in the native API`,
                e.loc?.start,
              );
            else if (e.name.value !== "__typename")
              this.issues.block(`${here}.${e.name.value}: unknown edge field`, e.loc?.start);
          }
          break;
        }
        case "totalCount":
          if (!rel.list) {
            this.issues.add(
              "note",
              `${here}: dropped: to-one relations have no count`,
              c.loc?.start,
            );
            break;
          }
          counts.push({
            rel: name,
            where: rel.list ? where : undefined,
            v7Key,
            read: (v) => rec(v)[c.alias?.value ?? "totalCount"],
          });
          break;
        case "pageInfo":
          this.issues.add(
            "note",
            `${here}: dropped: relation lists have no pageInfo in the native API`,
            c.loc?.start,
          );
          break;
        case "aggregate":
          counts.push(...this.relationAggregate(name, rel, where, c, v7Key, here));
          break;
        case "__typename":
          break;
        default:
          this.issues.block(`${here}: unknown connection field`, c.loc?.start);
      }
    }
    if (!hasEdges) return { counts };
    const sub: Selection = nodeSel
      ? this.nodeSelection(nodeSel, rel.target, `${at}.edges.node`)
      : { selections: [], map: () => ({}) };
    const selections = [...sub.selections];
    let mapEdge: MapFn | undefined;
    if (edgeSel) {
      const props = rel.properties;
      if (!props) {
        this.issues.block(
          `${at}.edges.properties: ${rel.name} has no relationship properties`,
          edgeSel.loc?.start,
        );
      } else {
        const edge = this.edgeSelection(props, edgeSel.selectionSet, `${at}.edges.properties`);
        selections.push(fieldNode("_edge", undefined, [], edge.selections));
        mapEdge = (v) => (v === null || v === undefined ? v : edge.map(rec(v)));
      }
    }
    if (!selections.length) selections.push(fieldNode("__typename", undefined, []));
    const item: Item = {
      name,
      alias: s.alias?.value,
      v7Key,
      args,
      directives: s.directives ?? [],
      selections,
      map: (v) => {
        const edges = (rec(v).edges ?? []) as Record<string, unknown>[];
        const nodes = edges.map((e) => {
          const out = sub.map(rec(e.node));
          if (mapEdge && "properties" in e) out._edge = mapEdge(e.properties);
          return out;
        });
        return rel.list ? nodes : (nodes[0] ?? null);
      },
    };
    return { item, counts };
  }

  /** `properties { roles screenTime }` → `_edge { roles screenTime }`. */
  private edgeSelection(props: string, set: SelectionSetNode | undefined, at: string): Selection {
    const items: Item[] = [];
    for (const s of set?.selections ?? []) {
      if (s.kind !== Kind.FIELD) {
        this.issues.block(`${at}: fragments on edge properties cannot be translated`, s.loc?.start);
        continue;
      }
      const name =
        s.name.value === "__typename"
          ? "__typename"
          : this.ctx.nativeEdgeProperty(props, s.name.value);
      items.push({
        name,
        alias: s.alias?.value ?? (name !== s.name.value ? s.name.value : undefined),
        v7Key: s.alias?.value ?? s.name.value,
        args: [],
        directives: s.directives ?? [],
        map: s.name.value === "__typename" ? () => props : undefined,
      });
    }
    return this.finish(items, [], [], set);
  }

  /** `aggregate { count { nodes } }` of a relation connection → `_count { actors }`. */
  private relationAggregate(
    name: string,
    rel: Relationship,
    where: Value | undefined,
    agg: FieldNode,
    v7Key: string,
    at: string,
  ): CountItem[] {
    const counts: CountItem[] = [];
    const aggKey = agg.alias?.value ?? "aggregate";
    for (const s of agg.selectionSet?.selections ?? []) {
      if (s.kind !== Kind.FIELD) continue;
      if (s.name.value === "count" && rel.list) {
        const countKey = s.alias?.value ?? "count";
        for (const c of s.selectionSet?.selections ?? []) {
          if (c.kind !== Kind.FIELD) continue;
          if (c.name.value === "nodes") {
            const nodesKey = c.alias?.value ?? "nodes";
            counts.push({
              rel: name,
              where,
              v7Key,
              read: (v) => rec(rec(rec(v)[aggKey])[countKey])[nodesKey],
            });
          } else if (c.name.value !== "__typename") {
            this.issues.add(
              "note",
              `${at}.count.${c.name.value}: dropped: the native API counts related nodes (_count), not edges`,
              c.loc?.start,
            );
          }
        }
      } else if (s.name.value !== "__typename") {
        this.issues.add(
          "note",
          `${at}.${s.name.value}: dropped: the native API aggregates related nodes and edges only as _count (aggregate the related model with its Aggregate root field, or use a Cypher-backed field)`,
          s.loc?.start,
        );
      }
    }
    return counts;
  }

  /** A v7 connection `where` (`{ node, edge, AND, OR, NOT }`) → a v7 `where` on the node. */
  private connectionNodeWhere(rel: Relationship, value: Value, at: string): Value {
    return this.where.connectionWhere(rel, value, at);
  }

  /**
   * v7 `sort: [{ title: ASC }]` (connections: `[{ node: { … } }, { edge: { … } }]`) →
   * `orderBy: [{ title: asc }]`, one entry per key.
   */
  orderBy(v7Type: string, value: Value, at: string, connection: boolean): Value | undefined {
    if (value.k === "var") {
      this.issues.block(
        `${at}: the variable $${value.name} holds a v7 sort; write it inline`,
        value.loc,
      );
      return undefined;
    }
    const node = this.ctx.v7Node(v7Type);
    const entries = value.k === "list" ? value.items : [value];
    const out: Value[] = [];
    const scalar = (key: string, dir: Value, here: string, loc?: number) => {
      const attr = node?.attributes.find((a) => a.name === key);
      const nativeName = attr ? this.ctx.nativeScalar(v7Type, attr)?.name : undefined;
      if (!nativeName) {
        this.issues.block(`${here}: cannot sort on ${v7Type}.${key} in the native API`, loc);
        return;
      }
      if (dir.k !== "enum" || !SORT_DIRECTIONS[dir.v]) {
        this.issues.block(
          `${here}: the sort direction must be written inline (ASC / DESC)`,
          dir.loc ?? loc,
        );
        return;
      }
      out.push(obj([field(nativeName, { k: "enum", v: SORT_DIRECTIONS[dir.v]! })]));
    };
    for (const e of entries) {
      if (!isObj(e)) {
        this.issues.block(`${at}: unexpected sort value`, e.loc);
        continue;
      }
      for (const f of e.fields) {
        const here = `${at}.${f.key}`;
        if (connection && f.key === "node") {
          if (isObj(f.value))
            for (const g of f.value.fields) scalar(g.key, g.value, `${here}.${g.key}`, g.loc);
          else this.issues.block(`${here}: unexpected sort value`, f.loc);
        } else if (connection && f.key === "edge") {
          this.issues.block(
            `${here}: the native API cannot sort relation lists on edge properties`,
            f.loc,
          );
        } else scalar(f.key, f.value, here, f.loc);
      }
    }
    return list(out);
  }

  // ---------------------------------------------------------------- root fields

  /** One root field of a query → native root fields. */
  queryRoot(s: FieldNode): { items: Item[] } {
    const name = s.name.value;
    const key = s.alias?.value ?? name;
    const at = key;
    if (name.startsWith("__")) {
      // __typename, and introspection (__schema, __type): the same in both APIs.
      return {
        items: [
          {
            name,
            alias: s.alias?.value,
            v7Key: key,
            args: s.arguments ?? [],
            directives: s.directives ?? [],
            selections: s.selectionSet?.selections,
          },
        ],
      };
    }
    const v7 = this.ctx.v7;
    // A field the type definitions declare on Query (a resolver or @cypher), also when it has the
    // name of a generated one (`@query(read: false)` and a resolver serving it).
    if (isCustomRoot(v7.query, name))
      return { items: [this.customRoot("query", s, at)].filter(isItem) };
    for (const n of [...v7.interfaces.values(), ...v7.nodes]) {
      if (n.plural === name) return { items: [this.findMany(n.name, s, at)].filter(isItem) };
      if (`${n.plural}Connection` === name) return { items: this.rootConnection(n, s, at) };
      const ft = n.fulltext.find((f) => f.queryName === name);
      if (ft) return { items: [this.search(n, ft.indexName, s, at)].filter(isItem) };
    }
    for (const u of v7.unions.values()) {
      if (u.plural === name) return { items: [this.findMany(u.name, s, at)].filter(isItem) };
    }
    return { items: [this.customRoot("query", s, at)].filter(isItem) };
  }

  /** A field of `Query` / `Mutation` the type definitions declare (`@cypher` or a resolver). */
  private customRoot(kind: "query" | "mutation", s: FieldNode, at: string): Item | undefined {
    const name = s.name.value;
    const type =
      kind === "query" ? this.ctx.v7Schema.getQueryType() : this.ctx.v7Schema.getMutationType();
    const def = type?.getFields()[name];
    if (!def) {
      this.issues.block(`${at}: unknown root field ${name}`, s.loc?.start);
      return undefined;
    }
    if (!this.ctx.hasRoot(kind, name)) {
      this.issues.block(
        `${at}: the custom ${kind} field ${name} is not in the native API: add it with extend (typeDefs and a resolver) in the native config`,
        s.loc?.start,
      );
      return undefined;
    }
    const generated = this.ctx.generatedRoot(name);
    if (generated) {
      this.issues.block(
        `${at}: ${name} is a custom ${kind} field in v7 and the generated ${generated} root field in the native API: name the native custom field differently (extend) or rename it with naming`,
        s.loc?.start,
      );
      return undefined;
    }
    const target = namedTypeName(def.type);
    const sub =
      s.selectionSet && target && this.ctx.v7Node(target)
        ? this.nodeSelection(s.selectionSet, target, at)
        : undefined;
    return {
      name,
      alias: s.alias?.value,
      v7Key: s.alias?.value ?? name,
      args: s.arguments ?? [],
      directives: s.directives ?? [],
      selections: sub ? sub.selections : s.selectionSet?.selections,
      map: sub ? mapList((v) => sub.map(rec(v))) : undefined,
    };
  }

  /** The native root field `operation` of the model of `v7Type`, or `undefined` (reported). */
  private root(
    kind: "query" | "mutation",
    v7Type: string,
    operation: Parameters<MigrationContext["rootField"]>[1],
    at: string,
    loc?: number,
  ): string | undefined {
    if (!this.ctx.nativeModel(v7Type)) {
      this.issues.block(`${at}: ${v7Type} ${missingModel(this.ctx, v7Type)}`, loc);
      return undefined;
    }
    const model = this.nativeName(v7Type);
    const name = this.ctx.rootField(model, operation);
    if (!this.ctx.hasRoot(kind, name)) {
      this.issues.block(
        `${at}: the native API does not serve ${name} (turn on ${model}'s ${operation} operation in the native config)`,
        loc,
      );
      return undefined;
    }
    return name;
  }

  /** `movies(where, sort, limit, offset)` → `movieFindMany(where, orderBy, take, skip) { nodes }`. */
  private findMany(v7Type: string, s: FieldNode, at: string): Item | undefined {
    const name = this.root("query", v7Type, "findMany", at, s.loc?.start);
    const args: ArgumentNode[] = [];
    for (const a of s.arguments ?? []) {
      const v = fromAst(a.value);
      const here = `${at}(${a.name.value})`;
      if (a.name.value === "where") args.push(arg("where", this.where.where(v7Type, v, here)));
      else if (a.name.value === "sort") {
        const o = this.orderBy(v7Type, v, here, false);
        if (o) args.push(arg("orderBy", o));
      } else if (a.name.value === "limit") this.take(args, v, here);
      else if (a.name.value === "offset") args.push(arg("skip", v));
      else this.issues.block(`${here}: unknown argument`, a.loc?.start);
    }
    const sub = this.nodeSelection(s.selectionSet, v7Type, at);
    if (!name) return undefined;
    return {
      name,
      alias: s.alias?.value,
      v7Key: s.alias?.value ?? s.name.value,
      args,
      directives: s.directives ?? [],
      selections: [fieldNode("nodes", undefined, [], sub.selections)],
      map: (v) => ({ nodes: Array.isArray(v) ? v.map((x) => sub.map(rec(x))) : v }),
    };
  }

  /**
   * `moviesConnection(first, after, sort, where) { totalCount edges { node } pageInfo aggregate }`
   * → `movieFindMany(take, after, orderBy, where) { nodes totalCount pageInfo }`, and
   * `movieAggregate(where)` for `aggregate`.
   */
  private rootConnection(n: NodeType, s: FieldNode, at: string): Item[] {
    const v7Key = s.alias?.value ?? s.name.value;
    const loc = s.loc?.start;
    let where: Value | undefined;
    const args: ArgumentNode[] = [];
    for (const a of s.arguments ?? []) {
      const v = fromAst(a.value);
      const here = `${at}(${a.name.value})`;
      if (a.name.value === "where") {
        where = this.where.where(n.name, v, here);
        args.push(arg("where", where));
      } else if (a.name.value === "sort") {
        const o = this.orderBy(n.name, v, here, false);
        if (o) args.push(arg("orderBy", o));
      } else if (a.name.value === "first") args.push(arg("take", v));
      else if (a.name.value === "after") {
        args.push(arg("after", v));
        this.issues.add(
          "known",
          `${here}: native cursors are keyset cursors (pageInfo.endCursor of the native API): a v7 cursor a client stored is not valid`,
          a.loc?.start,
        );
      } else this.issues.block(`${here}: unknown argument`, a.loc?.start);
    }
    let nodeSel: SelectionSetNode | undefined;
    const listSelections: SelectionNode[] = [];
    const parts: ((conn: Record<string, unknown>, out: Record<string, unknown>) => void)[] = [];
    let aggregate: FieldNode | undefined;
    let hasEdges = false;
    for (const c of s.selectionSet?.selections ?? []) {
      if (c.kind !== Kind.FIELD) {
        this.issues.block(
          `${at}: fragments on connection types cannot be translated`,
          c.loc?.start,
        );
        continue;
      }
      const here = `${at}.${c.name.value}`;
      const key = c.alias?.value ?? c.name.value;
      if (c.name.value === "edges") {
        if (c.alias) {
          this.issues.block(`${here}: aliased edges cannot be translated`, c.loc?.start);
          continue;
        }
        hasEdges = true;
        for (const e of c.selectionSet?.selections ?? []) {
          if (e.kind !== Kind.FIELD || e.alias) {
            this.issues.block(
              `${here}: fragments and aliases on edges cannot be translated`,
              e.loc?.start,
            );
            continue;
          }
          if (e.name.value === "node") nodeSel = mergeSets(nodeSel, e.selectionSet);
          else if (e.name.value === "cursor")
            this.issues.add(
              "note",
              `${here}.cursor: dropped: the native API has cursors per page (pageInfo), not per node`,
              e.loc?.start,
            );
          else if (e.name.value !== "__typename")
            this.issues.block(`${here}.${e.name.value}: unknown edge field`, e.loc?.start);
        }
      } else if (c.name.value === "totalCount") {
        listSelections.push(fieldNode("totalCount", c.alias?.value, []));
        parts.push((conn, out) => {
          if (key in conn) out[key] = conn[key];
        });
      } else if (c.name.value === "pageInfo") {
        const sel: SelectionNode[] = [];
        const keys: [string, boolean][] = [];
        for (const p of c.selectionSet?.selections ?? []) {
          if (p.kind !== Kind.FIELD) continue;
          sel.push(p);
          const pk = p.alias?.value ?? p.name.value;
          keys.push([pk, p.name.value === "startCursor" || p.name.value === "endCursor"]);
        }
        listSelections.push(fieldNode("pageInfo", c.alias?.value, [], sel));
        parts.push((conn, out) => {
          if (!(key in conn)) return;
          const info = rec(conn[key]);
          out[key] = Object.fromEntries(
            keys.map(([k, cursor]) => [
              k,
              cursor && info[k] !== null
                ? new Unmapped("v7 cursors are offsets, native cursors are keysets")
                : info[k],
            ]),
          );
        });
        if (keys.some(([, cursor]) => cursor)) {
          this.issues.add(
            "known",
            `${here}: native cursors differ from v7 cursors (keyset, not offset)`,
            c.loc?.start,
          );
        }
      } else if (c.name.value === "aggregate") {
        aggregate = c;
      } else if (c.name.value !== "__typename") {
        this.issues.block(`${here}: unknown connection field`, c.loc?.start);
      }
    }
    const items: Item[] = [];
    if (hasEdges || listSelections.length) {
      const name = this.root("query", n.name, "findMany", at, loc);
      const sub = hasEdges ? this.nodeSelection(nodeSel, n.name, `${at}.edges.node`) : undefined;
      if (name) {
        items.push({
          name,
          alias: s.alias?.value,
          v7Key,
          args,
          directives: s.directives ?? [],
          selections: [
            ...(sub ? [fieldNode("nodes", undefined, [], sub.selections)] : []),
            ...listSelections,
          ],
          map: (v) => {
            const conn = rec(v);
            const out: Record<string, unknown> = {};
            if (sub) {
              out.nodes = ((conn.edges ?? []) as unknown[]).map((e) => sub.map(rec(rec(e).node)));
            }
            for (const p of parts) p(conn, out);
            return out;
          },
        });
      }
    }
    if (aggregate) {
      const agg = this.rootAggregate(n, aggregate, where, `${at}.aggregate`);
      const name = this.root("query", n.name, "aggregate", `${at}.aggregate`, aggregate.loc?.start);
      if (name && agg) {
        const aggKey = aggregate.alias?.value ?? "aggregate";
        items.push({
          name,
          // Alone: the connection's key; next to the list: `<key>Aggregate`.
          alias: items.length ? `${v7Key}Aggregate` : s.alias?.value,
          v7Key,
          args: where ? [arg("where", where)] : [],
          directives: s.directives ?? [],
          selections: agg.selections,
          map: (v) => agg.map(rec(rec(v)[aggKey])),
        });
      }
    }
    if (!items.length && !this.issues.blocked) {
      this.issues.block(`${at}: nothing selected that the native API has`, loc);
    }
    return items;
  }

  /**
   * `aggregate { count { nodes } node { year { min max average sum } } }` →
   * `{ _count { _all } _min { year } _max { year } _avg { year } _sum { year } }`.
   */
  private rootAggregate(
    n: NodeType,
    agg: FieldNode,
    _where: Value | undefined,
    at: string,
  ): Selection | undefined {
    const groups = new Map<string, Map<string, string>>(); // _min → (native field → v7 path)
    const reads: [string, string, (v: Record<string, unknown>) => unknown][] = [];
    const add = (group: string, f: string, read: (v: Record<string, unknown>) => unknown) => {
      if (!groups.has(group)) groups.set(group, new Map());
      groups.get(group)!.set(f, f);
      reads.push([group, f, read]);
    };
    const OPS: Record<string, string> = { min: "_min", max: "_max", average: "_avg", sum: "_sum" };
    for (const s of agg.selectionSet?.selections ?? []) {
      if (s.kind !== Kind.FIELD) continue;
      const sk = s.alias?.value ?? s.name.value;
      if (s.name.value === "count") {
        for (const c of s.selectionSet?.selections ?? []) {
          if (c.kind !== Kind.FIELD) continue;
          const ck = c.alias?.value ?? c.name.value;
          if (c.name.value === "nodes") add("_count", "_all", (v) => rec(v[sk])[ck]);
          else if (c.name.value !== "__typename")
            this.issues.add("note", `${at}.count.${c.name.value}: dropped`, c.loc?.start);
        }
      } else if (s.name.value === "node") {
        for (const f of s.selectionSet?.selections ?? []) {
          if (f.kind !== Kind.FIELD || f.name.value === "__typename") continue;
          const fk = f.alias?.value ?? f.name.value;
          const attr = n.attributes.find((a) => a.name === f.name.value);
          const nativeName = attr ? this.ctx.nativeScalar(n.name, attr)?.name : undefined;
          if (!nativeName) {
            this.issues.add(
              "note",
              `${at}.node.${f.name.value}: dropped: not a field of the Cyphra model`,
              f.loc?.start,
            );
            continue;
          }
          for (const o of f.selectionSet?.selections ?? []) {
            if (o.kind !== Kind.FIELD || o.name.value === "__typename") continue;
            const ok = o.alias?.value ?? o.name.value;
            const group = OPS[o.name.value];
            if (!group) {
              this.issues.add(
                "note",
                `${at}.node.${f.name.value}.${o.name.value}: dropped: the native API has no ${o.name.value} aggregate (_min / _max compare values, not lengths)`,
                o.loc?.start,
              );
              continue;
            }
            add(group, nativeName, (v) => rec(rec(v[sk])[fk])[ok]);
          }
        }
      } else if (s.name.value !== "__typename") {
        this.issues.add("note", `${at}.${s.name.value}: dropped`, s.loc?.start);
      }
    }
    if (!groups.size) {
      this.issues.add("note", `${at}: dropped: no aggregate the native API has`, agg.loc?.start);
      return undefined;
    }
    const selections = [...groups.entries()].map(([g, fs]) =>
      fieldNode(
        g,
        undefined,
        [],
        [...fs.keys()].map((f) => fieldNode(f, undefined, [])),
      ),
    );
    return {
      selections,
      map: (v) => {
        const out: Record<string, Record<string, unknown>> = {};
        for (const [g, f, read] of reads) (out[g] ??= {})[f] = read(v);
        return out;
      },
    };
  }

  /**
   * `moviesByTitle(phrase, where: { node, score }, first) { edges { score node } }` →
   * `movieSearch(index, query, mode: lucene, where, minScore, take) { … _score }`.
   */
  private search(n: NodeType, index: string, s: FieldNode, at: string): Item | undefined {
    const name = this.root("query", n.name, "search", at, s.loc?.start);
    const args: ArgumentNode[] = [arg("index", { k: "enum", v: index })];
    for (const a of s.arguments ?? []) {
      const v = fromAst(a.value);
      const here = `${at}(${a.name.value})`;
      if (a.name.value === "phrase") {
        args.push(arg("query", v), arg("mode", { k: "enum", v: "lucene" }));
      } else if (a.name.value === "where") {
        if (!isObj(v)) {
          this.issues.block(`${here}: write the full-text where inline`, v.loc);
          continue;
        }
        for (const f of v.fields) {
          if (f.key === "node")
            args.push(arg("where", this.where.where(n.name, f.value, `${here}.node`)));
          else if (f.key === "score" && isObj(f.value)) {
            for (const sf of f.value.fields) {
              if (sf.key === "min") args.push(arg("minScore", sf.value));
              else
                this.issues.block(
                  `${here}.score.${sf.key}: the native search only has minScore`,
                  sf.loc,
                );
            }
          } else this.issues.block(`${here}.${f.key}: unknown full-text filter`, f.loc);
        }
      } else if (a.name.value === "sort") {
        const entries = v.k === "list" ? v.items : [v];
        const ok = entries.every(
          (e) =>
            isObj(e) &&
            e.fields.length === 1 &&
            e.fields[0]!.key === "score" &&
            e.fields[0]!.value.k === "enum" &&
            (e.fields[0]!.value as { v: string }).v === "DESC",
        );
        if (!ok)
          this.issues.block(
            `${here}: native search results are sorted by score, best first (no other sort)`,
            a.loc?.start,
          );
      } else if (a.name.value === "first") args.push(arg("take", v));
      else if (a.name.value === "after")
        this.issues.block(
          `${here}: native search results have no cursors (use skip / take)`,
          a.loc?.start,
        );
      else this.issues.block(`${here}: unknown argument`, a.loc?.start);
    }
    let nodeSel: SelectionSetNode | undefined;
    let score: FieldNode | undefined;
    for (const c of s.selectionSet?.selections ?? []) {
      if (c.kind !== Kind.FIELD) continue;
      if (c.name.value === "edges") {
        for (const e of c.selectionSet?.selections ?? []) {
          if (e.kind !== Kind.FIELD) continue;
          if (e.name.value === "node") nodeSel = mergeSets(nodeSel, e.selectionSet);
          else if (e.name.value === "score") score = e;
          else if (e.name.value !== "__typename")
            this.issues.add("note", `${at}.edges.${e.name.value}: dropped`, e.loc?.start);
        }
      } else if (c.name.value !== "__typename") {
        this.issues.add(
          "note",
          `${at}.${c.name.value}: dropped: native search returns a list of nodes`,
          c.loc?.start,
        );
      }
    }
    const sub = this.nodeSelection(nodeSel, n.name, `${at}.edges.node`);
    if (!name) return undefined;
    return {
      name,
      alias: s.alias?.value,
      v7Key: s.alias?.value ?? s.name.value,
      args,
      directives: s.directives ?? [],
      selections: [...sub.selections, ...(score ? [fieldNode("_score", undefined, [])] : [])],
      map: (v) =>
        ((rec(v).edges ?? []) as Record<string, unknown>[]).map((e) => {
          const out = sub.map(rec(e.node));
          if (score) out._score = e.score;
          return out;
        }),
    };
  }

  // ---------------------------------------------------------------- mutations

  /** One root field of a mutation → native root fields. */
  mutationRoot(s: FieldNode): { items: Item[] } {
    const name = s.name.value;
    const at = s.alias?.value ?? name;
    if (name === "__typename") {
      return {
        items: [
          { name, alias: s.alias?.value, v7Key: at, args: [], directives: s.directives ?? [] },
        ],
      };
    }
    if (isCustomRoot(this.ctx.v7.mutation, name)) {
      return { items: [this.customRoot("mutation", s, at)].filter(isItem) };
    }
    for (const n of this.ctx.v7.nodes) {
      if (name === `create${n.pascalPlural}`)
        return { items: [this.create(n, s, at)].filter(isItem) };
      if (name === `update${n.pascalPlural}`)
        return { items: [this.update(n, s, at)].filter(isItem) };
      if (name === `delete${n.pascalPlural}`)
        return { items: [this.delete(n, s, at)].filter(isItem) };
    }
    return { items: [this.customRoot("mutation", s, at)].filter(isItem) };
  }

  /** The `info` and node list selections of a v7 mutation response. */
  private response(n: NodeType, s: FieldNode, at: string): { nodes?: FieldNode; info?: FieldNode } {
    let nodes: FieldNode | undefined;
    let info: FieldNode | undefined;
    for (const c of s.selectionSet?.selections ?? []) {
      if (c.kind !== Kind.FIELD) {
        this.issues.block(
          `${at}: fragments on mutation responses cannot be translated`,
          c.loc?.start,
        );
        continue;
      }
      if (c.name.value === n.plural) {
        if (nodes)
          this.issues.block(`${at}.${c.name.value}: selected twice (aliases)`, c.loc?.start);
        nodes = c;
      } else if (c.name.value === "info") info = c;
      else if (c.name.value !== "__typename")
        this.issues.block(`${at}.${c.name.value}: unknown field`, c.loc?.start);
    }
    return { nodes, info };
  }

  /** `info { nodesCreated … }`: kept as `count` when `countOf` is set, otherwise dropped. */
  private info(
    info: FieldNode | undefined,
    at: string,
    countOf?: string,
  ): { key?: string; v7Key?: string } {
    if (!info) return {};
    let key: string | undefined;
    for (const f of info.selectionSet?.selections ?? []) {
      if (f.kind !== Kind.FIELD || f.name.value === "__typename") continue;
      if (countOf && f.name.value === countOf) key = f.alias?.value ?? f.name.value;
      else
        this.issues.add(
          "note",
          `${at}.info.${f.name.value}: dropped: the native API returns the records (and count for batches)`,
          f.loc?.start,
        );
    }
    return { key, v7Key: info.alias?.value ?? "info" };
  }

  /**
   * `createMovies(input: [{ … }])` → `movieCreate(data)` (one input) or `movieCreateMany(data)`
   * (several, without nested writes).
   */
  private create(n: NodeType, s: FieldNode, at: string): Item | undefined {
    const input = s.arguments?.find((a) => a.name.value === "input");
    if (!input) {
      this.issues.block(`${at}: no input`, s.loc?.start);
      return undefined;
    }
    const v = fromAst(input.value);
    if (v.k === "var") {
      this.issues.block(
        `${at}(input): the variable $${v.name} holds v7 create inputs; write the input inline (or build the native data in the client)`,
        v.loc,
      );
      return undefined;
    }
    const inputs = v.k === "list" ? v.items : [v];
    let nested = false;
    const data = inputs.map((x, i) => {
      const r = this.createData(n, x, `${at}(input[${i}])`);
      nested ||= r.nested;
      return r.data;
    });
    const { nodes, info } = this.response(n, s, at);
    const nodeType = n.name;
    const sub = nodes
      ? this.nodeSelection(nodes.selectionSet, nodeType, `${at}.${n.plural}`)
      : undefined;
    const nodesKey = nodes ? (nodes.alias?.value ?? nodes.name.value) : undefined;
    if (inputs.length === 1) {
      this.info(info, at);
      const name = this.root("mutation", nodeType, "create", at, s.loc?.start);
      if (!name) return undefined;
      return {
        name,
        alias: s.alias?.value,
        v7Key: s.alias?.value ?? s.name.value,
        args: [arg("data", data[0]!)],
        directives: s.directives ?? [],
        selections: sub?.selections ?? [fieldNode("__typename", undefined, [])],
        map: (r) => {
          if (!sub || !nodesKey) return { __typename: this.nativeName(nodeType) };
          const list = rec(r)[nodesKey];
          return Array.isArray(list) && list.length ? sub.map(rec(list[0])) : null;
        },
      };
    }
    if (nested) {
      this.issues.block(
        `${at}: several inputs with nested writes: write one ${this.ctx.rootField(this.nativeName(nodeType), "create")} per input (createMany takes no nested writes)`,
        s.loc?.start,
      );
      return undefined;
    }
    const { key: countKey, v7Key: infoKey } = this.info(info, at, "nodesCreated");
    const name = this.root("mutation", nodeType, "createMany", at, s.loc?.start);
    if (!name) return undefined;
    return {
      name,
      alias: s.alias?.value,
      v7Key: s.alias?.value ?? s.name.value,
      args: [arg("data", list(data))],
      directives: s.directives ?? [],
      selections: [
        ...(countKey || !sub ? [fieldNode("count", undefined, [])] : []),
        ...(sub ? [fieldNode("nodes", undefined, [], sub.selections)] : []),
      ],
      map: (r) => {
        const out: Record<string, unknown> = {};
        if (countKey && infoKey) out.count = rec(rec(r)[infoKey])[countKey];
        else if (!sub) out.count = new Unmapped("v7 selected no count");
        if (sub && nodesKey)
          out.nodes = ((rec(r)[nodesKey] ?? []) as unknown[]).map((x) => sub.map(rec(x)));
        return out;
      },
    };
  }

  /** A v7 `${Type}CreateInput` → the native create `data`; `nested` when it has relation writes. */
  private createData(n: NodeType, value: Value, at: string): { data: Value; nested: boolean } {
    if (!isObj(value)) {
      this.issues.block(`${at}: write the create input inline`, value.loc);
      return { data: value, nested: false };
    }
    const fields: Field[] = [];
    let nested = false;
    for (const f of value.fields) {
      const here = `${at}.${f.key}`;
      // v7's placeholder of a create input without settable fields.
      if (f.key === "_emptyInput") continue;
      const attr = n.attributes.find((a) => a.name === f.key);
      if (attr) {
        const name = this.ctx.nativeScalar(n.name, attr)?.name;
        if (!name)
          this.issues.block(
            `${here}: ${n.name}.${f.key} is not a field of the Cyphra model`,
            f.loc,
          );
        else fields.push(field(name, f.value, f.loc));
        continue;
      }
      const rel = n.relationships.find((r) => r.name === f.key);
      if (rel) {
        nested = true;
        const name = this.relationName(n, rel, here, f.loc);
        const w = name ? this.relationWrite(rel, f.value, here, "create") : undefined;
        if (name && w) fields.push(field(name, w, f.loc));
        continue;
      }
      this.issues.block(`${here}: unknown create input field`, f.loc);
    }
    return { data: obj(fields, value.loc), nested };
  }

  /** v7 edge `{ roles: […] }` → native `_edge` values (property names of the edge model). */
  private edgeData(
    rel: Relationship,
    value: Value,
    at: string,
    mode: "create" | "update",
  ): Value | undefined {
    if (!rel.properties) {
      this.issues.block(`${at}: ${rel.name} has no relationship properties`, value.loc);
      return undefined;
    }
    if (!isObj(value)) {
      this.issues.block(`${at}: write the edge properties inline`, value.loc);
      return undefined;
    }
    if (mode === "update") {
      this.issues.block(
        `${at}: updating edge properties in a nested update has no native equivalent (use connect with _edge)`,
        value.loc,
      );
      return undefined;
    }
    return obj(
      value.fields.map((f) =>
        field(this.ctx.nativeEdgeProperty(rel.properties!, f.key), f.value, f.loc),
      ),
    );
  }

  /**
   * The unique `where` of a native connect / disconnect / nested update from a v7 `where: { node:
   * … }` (translated): it must compare a unique field of the target for equality.
   */
  private unique(
    target: string,
    value: Value | undefined,
    at: string,
    what: string,
    loc?: number,
  ): ObjValue | undefined {
    const v7Where =
      value && isObj(value)
        ? (get(value, "node") ?? (value.fields.length === 0 ? undefined : value))
        : value;
    if (!v7Where || (isObj(v7Where) && v7Where.fields.length === 0)) {
      this.issues.block(
        `${at}: ${what} without a where (every node) has no native equivalent: ${what} by unique key`,
        loc,
      );
      return undefined;
    }
    if (isObj(value) && get(value, "edge")) {
      this.issues.block(`${at}.edge: ${what} by edge properties has no native equivalent`, loc);
      return undefined;
    }
    const w = this.where.where(target, v7Where, `${at}.node`);
    const model = this.ctx.nativeModel(target);
    const uniques = new Set(
      (model?.fields ?? [])
        .filter((f): f is ResolvedScalarField => f.kind === "scalar" && (f.id || f.unique))
        .map((f) => f.name),
    );
    if (!isObj(w)) return undefined;
    const fields: Field[] = [];
    let keyed = false;
    for (const f of w.fields) {
      const eq =
        isObj(f.value) && f.value.fields.length === 1 && f.value.fields[0]!.key === "equals"
          ? f.value.fields[0]!.value
          : undefined;
      if (!keyed && uniques.has(f.key) && eq && eq.k !== "null") {
        fields.push(field(f.key, eq, f.loc));
        keyed = true;
      } else fields.push(f);
    }
    if (!keyed) {
      this.issues.block(
        uniques.size
          ? `${at}: ${what} by a non-unique where (it can match several nodes) has no native equivalent: ${what} by a unique key (${[...uniques].join(", ")}) or write a custom mutation`
          : `${at}: ${what} needs a unique key, and ${model?.name ?? target} has no @id or @unique field in schema.cyphra (mark one, e.g. cyphra import graphql --id-fields ${target}.id)`,
        loc,
      );
      return undefined;
    }
    return obj(fields);
  }

  /**
   * A v7 nested relationship write (`{ create, connect, disconnect, update, delete }`, a list of
   * them for to-many relationships on update) → the native relation input.
   */
  private relationWrite(
    rel: Relationship,
    value: Value,
    at: string,
    mode: "create" | "update",
  ): Value | undefined {
    if (this.ctx.v7.unions.has(rel.target) || this.ctx.v7.interfaces.has(rel.target)) {
      this.issues.block(
        `${at}: nested writes to a union or interface relationship cannot be translated (write them by hand: connect: { Member: { … } })`,
        value.loc,
      );
      return undefined;
    }
    if (value.k === "var") {
      this.issues.block(`${at}: the variable $${value.name} holds a v7 nested write`, value.loc);
      return undefined;
    }
    const target = this.ctx.v7Node(rel.target)!;
    const inputs = value.k === "list" ? value.items : [value];
    const out = new Map<string, Value[]>();
    const push = (k: string, v: Value) => out.set(k, [...(out.get(k) ?? []), v]);
    const one: Map<string, Value> | undefined = rel.list ? undefined : new Map();
    for (const input of inputs) {
      if (!isObj(input)) {
        this.issues.block(`${at}: unexpected nested write`, input.loc);
        continue;
      }
      const fieldWhere = get(input, "where");
      for (const f of input.fields) {
        const here = `${at}.${f.key}`;
        const items = f.value.k === "list" ? f.value.items : [f.value];
        switch (f.key) {
          case "where":
            break;
          case "create":
            for (const it of items) {
              const node = get(it, "node");
              const edge = get(it, "edge");
              if (!node) {
                this.issues.block(`${here}: no node`, it.loc);
                continue;
              }
              const d = this.createData(target, node, `${here}.node`);
              const e = edge ? this.edgeData(rel, edge, `${here}.edge`, "create") : undefined;
              const data = isObj(d.data)
                ? obj([...d.data.fields, ...(e ? [field("_edge", e)] : [])])
                : d.data;
              if (one) one.set("create", data);
              else push("create", data);
            }
            break;
          case "connect":
            this.issues.add(
              "known",
              `${here}: connect is a MERGE in the native API (v7 created another edge when the nodes were already linked)`,
              f.loc,
              true,
            );
            for (const it of items) {
              if (!isObj(it)) {
                this.issues.block(`${here}: write the connect input inline`, it.loc);
                continue;
              }
              if (get(it, "connect")) {
                this.issues.block(
                  `${here}.connect: connects nested in a connect have no native equivalent (connect from the other node in its own mutation)`,
                  it.loc,
                );
                continue;
              }
              const u = this.unique(rel.target, get(it, "where"), here, "connect", it.loc);
              if (!u) continue;
              const edge = get(it, "edge");
              const e = edge ? this.edgeData(rel, edge, `${here}.edge`, "create") : undefined;
              const c = obj([...u.fields, ...(e ? [field("_edge", e)] : [])]);
              if (one) one.set("connect", c);
              else push("connect", c);
            }
            break;
          case "disconnect":
          case "delete":
            for (const it of items) {
              if (!isObj(it)) {
                this.issues.block(`${here}: write the ${f.key} input inline`, it.loc);
                continue;
              }
              if (get(it, "delete") || get(it, "disconnect")) {
                this.issues.block(
                  `${here}: nested ${f.key}s inside a ${f.key} have no native equivalent`,
                  it.loc,
                );
                continue;
              }
              if (one) {
                const w = get(it, "where");
                if (w && !(isObj(w) && w.fields.length === 0)) {
                  this.issues.block(
                    `${here}: a to-one ${f.key} with a where has no native equivalent (native ${f.key}: true acts on the linked node, whichever it is)`,
                    it.loc,
                  );
                  continue;
                }
                one.set(f.key, { k: "boolean", v: true });
                continue;
              }
              const u = this.unique(rel.target, get(it, "where"), here, f.key, it.loc);
              if (u) push(f.key, u);
            }
            break;
          case "update": {
            if (!isObj(f.value)) {
              this.issues.block(`${here}: write the nested update inline`, f.loc);
              break;
            }
            const node = get(f.value, "node");
            if (get(f.value, "edge"))
              this.edgeData(rel, get(f.value, "edge")!, `${here}.edge`, "update");
            if (!node) break;
            const d = this.updateData(target, node, `${here}.node`);
            if (one) {
              if (fieldWhere && !(isObj(fieldWhere) && fieldWhere.fields.length === 0)) {
                this.issues.block(
                  `${here}: a to-one update with a where has no native equivalent (native update acts on the linked node)`,
                  f.loc,
                );
                break;
              }
              one.set("update", d.data);
            } else {
              const u = this.unique(rel.target, fieldWhere, `${at}.where`, "update", f.loc);
              if (u) push("update", obj([field("where", u), field("data", d.data)]));
            }
            break;
          }
          default:
            this.issues.block(`${here}: ${f.key} has no native equivalent`, f.loc);
        }
      }
    }
    if (mode === "create") {
      for (const k of ["disconnect", "delete", "update"]) {
        if (out.has(k) || one?.has(k)) this.issues.block(`${at}.${k}: not in a create`, value.loc);
      }
    }
    if (one) return obj([...one.entries()].map(([k, v]) => field(k, v)));
    return obj([...out.entries()].map(([k, v]) => field(k, list(v))));
  }

  /** A v7 `${Type}UpdateInput` → native update `data` (`_ops` for arithmetic). */
  private updateData(n: NodeType, value: Value, at: string): { data: Value; nested: boolean } {
    if (!isObj(value)) {
      this.issues.block(`${at}: write the update input inline`, value.loc);
      return { data: value, nested: false };
    }
    const fields: Field[] = [];
    const ops: Field[] = [];
    let nested = false;
    const OPS: Record<string, string | undefined> = {
      set: "set",
      add: "increment",
      increment: "increment",
      subtract: "decrement",
      decrement: "decrement",
      multiply: "multiply",
      divide: undefined,
      push: undefined,
      pop: undefined,
    };
    const SUFFIX = /^(.+?)_(SET|ADD|INCREMENT|SUBTRACT|DECREMENT|MULTIPLY|DIVIDE|PUSH|POP)$/;
    const scalar = (attrName: string, op: string, v: Value, here: string, loc?: number) => {
      const attr = n.attributes.find((a) => a.name === attrName)!;
      const name = this.ctx.nativeScalar(n.name, attr)?.name;
      if (!name) {
        this.issues.block(`${here}: ${n.name}.${attrName} is not a field of the Cyphra model`, loc);
        return;
      }
      const native = OPS[op];
      if (native === undefined) {
        this.issues.block(
          `${here}: ${op} has no native equivalent${op === "push" || op === "pop" ? " (set the whole list)" : ""}`,
          loc,
        );
      } else if (native === "set") fields.push(field(name, v, loc));
      else ops.push(field(name, obj([field(native, v)]), loc));
    };
    for (const f of value.fields) {
      const here = `${at}.${f.key}`;
      const attr = n.attributes.find((a) => a.name === f.key);
      if (attr) {
        if (!isObj(f.value)) {
          this.issues.block(`${here}: write the update inline ({ set: … })`, f.loc);
          continue;
        }
        for (const o of f.value.fields)
          scalar(attr.name, o.key, o.value, `${here}.${o.key}`, o.loc);
        continue;
      }
      const suffix = SUFFIX.exec(f.key);
      if (suffix && n.attributes.some((a) => a.name === suffix[1])) {
        scalar(suffix[1]!, suffix[2]!.toLowerCase(), f.value, here, f.loc);
        continue;
      }
      const rel = n.relationships.find((r) => r.name === f.key);
      if (rel) {
        nested = true;
        const name = this.relationName(n, rel, here, f.loc);
        const w = name ? this.relationWrite(rel, f.value, here, "update") : undefined;
        if (name && w) fields.push(field(name, w, f.loc));
        continue;
      }
      this.issues.block(`${here}: unknown update input field`, f.loc);
    }
    if (ops.length) fields.push(field("_ops", obj(ops)));
    return { data: obj(fields, value.loc), nested };
  }

  /**
   * `updateMovies(where, update)` → `movieUpdateMany(where, data) { nodes }`, or, with nested
   * writes, `movieUpdate(where: unique, data)`.
   */
  private update(n: NodeType, s: FieldNode, at: string): Item | undefined {
    const whereArg = s.arguments?.find((a) => a.name.value === "where");
    const updateArg = s.arguments?.find((a) => a.name.value === "update");
    for (const a of s.arguments ?? []) {
      if (a.name.value !== "where" && a.name.value !== "update")
        this.issues.block(`${at}(${a.name.value}): unknown argument`, a.loc?.start);
    }
    const v7Where = whereArg ? fromAst(whereArg.value) : undefined;
    const upd = updateArg ? fromAst(updateArg.value) : obj([]);
    if (upd.k === "var") {
      this.issues.block(
        `${at}(update): the variable $${upd.name} holds a v7 update input; write it inline`,
        upd.loc,
      );
      return undefined;
    }
    const d = this.updateData(n, upd, `${at}(update)`);
    const { nodes, info } = this.response(n, s, at);
    this.info(info, at);
    const sub = nodes
      ? this.nodeSelection(nodes.selectionSet, n.name, `${at}.${n.plural}`)
      : undefined;
    const nodesKey = nodes ? (nodes.alias?.value ?? nodes.name.value) : undefined;
    if (d.nested) {
      const u = this.unique(
        n.name,
        v7Where ? obj([field("node", v7Where)]) : undefined,
        `${at}(where)`,
        "an update with nested writes",
        whereArg?.loc?.start,
      );
      const name = this.root("mutation", n.name, "update", at, s.loc?.start);
      if (!u || !name) return undefined;
      this.issues.add(
        "known",
        `${at}: ${name} fails with NOT_FOUND when no node matches (v7 returned an empty list)`,
        s.loc?.start,
        true,
      );
      return {
        name,
        alias: s.alias?.value,
        v7Key: s.alias?.value ?? s.name.value,
        args: [arg("where", u), arg("data", d.data)],
        directives: s.directives ?? [],
        selections: sub?.selections ?? [fieldNode("__typename", undefined, [])],
        map: (r) => {
          if (!sub || !nodesKey) return { __typename: this.nativeName(n.name) };
          const l = rec(r)[nodesKey];
          return Array.isArray(l) && l.length ? sub.map(rec(l[0])) : null;
        },
      };
    }
    const name = this.root("mutation", n.name, "updateMany", at, s.loc?.start);
    const where = v7Where ? this.where.where(n.name, v7Where, `${at}(where)`) : undefined;
    if (!name) return undefined;
    return {
      name,
      alias: s.alias?.value,
      v7Key: s.alias?.value ?? s.name.value,
      args: [...(where ? [arg("where", where)] : []), arg("data", d.data)],
      directives: s.directives ?? [],
      selections: sub
        ? [fieldNode("nodes", undefined, [], sub.selections)]
        : [fieldNode("count", undefined, [])],
      map: (r) =>
        sub && nodesKey
          ? { nodes: ((rec(r)[nodesKey] ?? []) as unknown[]).map((x) => sub.map(rec(x))) }
          : { count: new Unmapped("v7 has no count of updated nodes") },
    };
  }

  /** `deleteMovies(where) { nodesDeleted }` → `movieDeleteMany(where) { count }`. */
  private delete(n: NodeType, s: FieldNode, at: string): Item | undefined {
    let where: Value | undefined;
    for (const a of s.arguments ?? []) {
      const v = fromAst(a.value);
      if (a.name.value === "where") where = this.where.where(n.name, v, `${at}(where)`);
      else if (a.name.value === "delete") {
        this.issues.block(
          `${at}(delete): nested deletes have no native equivalent on deleteMany: set onDelete: Cascade on the relation in schema.cyphra, or use a nested delete in ${this.ctx.rootField(this.nativeName(n.name), "update")}`,
          a.loc?.start,
        );
      } else this.issues.block(`${at}(${a.name.value}): unknown argument`, a.loc?.start);
    }
    let countKey: string | undefined;
    for (const c of s.selectionSet?.selections ?? []) {
      if (c.kind !== Kind.FIELD || c.name.value === "__typename") continue;
      if (c.name.value === "nodesDeleted") countKey = c.alias?.value ?? c.name.value;
      else
        this.issues.add(
          "note",
          `${at}.${c.name.value}: dropped: deleteMany returns count and nodes`,
          c.loc?.start,
        );
    }
    const name = this.root("mutation", n.name, "deleteMany", at, s.loc?.start);
    if (!name) return undefined;
    return {
      name,
      alias: s.alias?.value,
      v7Key: s.alias?.value ?? s.name.value,
      args: where ? [arg("where", where)] : [],
      directives: s.directives ?? [],
      selections: [fieldNode("count", undefined, [])],
      map: (r) => ({
        count: countKey ? rec(r)[countKey] : new Unmapped("v7 selected no nodesDeleted"),
      }),
    };
  }

  // ---------------------------------------------------------------- definitions

  operation(op: OperationDefinitionNode): {
    node?: OperationDefinitionNode;
    map?: DefinitionTranslation["mapData"];
  } {
    if (op.operation === "subscription") {
      this.issues.block(
        `${op.name?.value ?? "subscription"}: subscriptions are not translated (the native ones, <model>Changed, have another shape); rewrite it by hand or keep it on compat.v7`,
        op.loc?.start,
      );
      return {};
    }
    const items: Item[] = [];
    for (const s of op.selectionSet.selections) {
      if (s.kind !== Kind.FIELD) {
        this.issues.block(
          `fragments on ${op.operation === "query" ? "Query" : "Mutation"} cannot be translated`,
          s.loc?.start,
        );
        continue;
      }
      items.push(...(op.operation === "query" ? this.queryRoot(s) : this.mutationRoot(s)).items);
    }
    const sel = this.finish(items, [], [], op.selectionSet);
    return {
      node: { ...op, selectionSet: { kind: Kind.SELECTION_SET, selections: sel.selections } },
      map: (data) => sel.map(data),
    };
  }

  fragment(f: FragmentDefinitionNode): FragmentDefinitionNode | undefined {
    const type = f.typeCondition.name.value;
    if (!this.ctx.v7Node(type) && !this.ctx.v7.unions.has(type)) {
      this.issues.block(
        `fragment ${f.name.value}: fragments on ${type} cannot be translated (only on @node types, interfaces and unions)`,
        f.loc?.start,
      );
      return undefined;
    }
    const sel = this.nodeSelection(f.selectionSet, type, `fragment ${f.name.value}`);
    this.fragmentMaps.set(f.name.value, sel.map);
    return {
      ...f,
      typeCondition: { kind: Kind.NAMED_TYPE, name: NAME(this.nativeName(type)) },
      selectionSet: { kind: Kind.SELECTION_SET, selections: sel.selections },
    };
  }

  get fragmentDefinitions(): ReadonlyMap<string, FragmentDefinitionNode> {
    return this.fragments;
  }
}

/** Why a v7 type has no native type. */
function missingModel(ctx: MigrationContext, v7Type: string): string {
  if (ctx.v7.interfaces.has(v7Type)) {
    return "is not a model of schema.cyphra (a v7 interface adds no label: convert it with --add-interface-labels, which needs the label on the nodes)";
  }
  return "is not a model of schema.cyphra";
}

function isCustomRoot(root: MigrationContext["v7"]["query"], name: string): boolean {
  return root.fields.some((f) => f.name === name) || root.resolved.some((f) => f.name === name);
}

function isItem(x: Item | undefined): x is Item {
  return x !== undefined;
}

/** The name of the named type under list / non-null wrappers. */
function namedTypeName(t: unknown): string | undefined {
  let x = t as { ofType?: unknown; name?: string };
  while (x && x.ofType) x = x.ofType as typeof x;
  return x?.name;
}

/** The selections of two sets (`edges { node { a } } edges { node { b } }`). */
function mergeSets(
  a: SelectionSetNode | undefined,
  b: SelectionSetNode | undefined,
): SelectionSetNode | undefined {
  if (!a) return b;
  if (!b) return a;
  return { kind: Kind.SELECTION_SET, selections: [...a.selections, ...b.selections] };
}

/** The validation rules for documents that may hold fragments used elsewhere. */
const RULES = specifiedRules.filter((r) => r !== NoUnusedFragmentsRule);

/**
 * Give each variable the native type of where it is used (`ID` stays `ID`, a v7 enum becomes
 * the native enum of the same values), and drop variables no longer used.
 */
function retypeVariables(
  ctx: MigrationContext,
  op: OperationDefinitionNode,
  fragments: readonly FragmentDefinitionNode[],
  issues: Issues,
): OperationDefinitionNode {
  const doc: DocumentNode = { kind: Kind.DOCUMENT, definitions: [op, ...fragments] };
  const typeInfo = new TypeInfo(ctx.nativeSchema);
  const usages = new Map<string, GraphQLInputType[]>();
  visit(
    doc,
    visitWithTypeInfo(typeInfo, {
      Variable(node) {
        const t = typeInfo.getInputType();
        if (t) usages.set(node.name.value, [...(usages.get(node.name.value) ?? []), t]);
      },
      VariableDefinition() {
        return false;
      },
    }),
  );
  const defs: VariableDefinitionNode[] = [];
  for (const d of op.variableDefinitions ?? []) {
    const name = d.variable.name.value;
    const types = usages.get(name);
    if (!types?.length) {
      issues.add("note", `$${name}: dropped: no longer used`, d.loc?.start);
      continue;
    }
    const v7Named = namedOfTypeNode(d.type);
    const v7Type = ctx.v7Schema.getType(v7Named);
    if (v7Type && isInputObjectType(v7Type)) {
      issues.block(
        `$${name}: the variable holds a v7 ${v7Named}; write the value inline`,
        d.loc?.start,
      );
    }
    if (v7Type && isEnumType(v7Type) && !ctx.v7.enums.has(v7Named)) {
      issues.block(
        `$${name}: the variable holds a v7 ${v7Named} value; write it inline`,
        d.loc?.start,
      );
    }
    const expected = types[0]!;
    let type: TypeNode = parseType(String(expected));
    if (d.type.kind === Kind.NON_NULL_TYPE && type.kind !== Kind.NON_NULL_TYPE) {
      type = { kind: Kind.NON_NULL_TYPE, type };
    }
    if (types.some((t) => String(t) !== String(expected) && namedOf(t) !== namedOf(expected))) {
      issues.block(
        `$${name}: used where the native API expects different types (${types.map(String).join(", ")})`,
        d.loc?.start,
      );
    }
    defs.push({ ...d, type });
  }
  return { ...op, variableDefinitions: defs };
}

function namedOfTypeNode(t: TypeNode): string {
  return t.kind === Kind.NAMED_TYPE ? t.name.value : namedOfTypeNode(t.type);
}

function namedOf(t: GraphQLInputType): string {
  let x: GraphQLInputType = t;
  while (isNonNullType(x) || isListType(x)) x = x.ofType as GraphQLInputType;
  return (x as { name: string }).name;
}

/** Offset → `{ line, column }` (1-based). */
export function position(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return { line, column };
}

/** Start of the `# cyphra:` comment lines right above the line of `start` (or that line's start). */
function commentBlockStart(source: string, start: number): number {
  let begin = source.lastIndexOf("\n", start - 1) + 1;
  while (begin > 0) {
    const prevStart = source.lastIndexOf("\n", begin - 2) + 1;
    if (!/^\s*# cyphra: /.test(source.slice(prevStart, begin - 1))) break;
    begin = prevStart;
  }
  return begin;
}

function commentLines(issues: readonly MigrationIssue[], indent: string): string {
  return issues
    .map(
      (i) =>
        `${indent}# cyphra: ${i.kind === "blocking" ? "not translated: " : ""}${i.message.replace(/\n/g, " ")}\n`,
    )
    .join("");
}

/**
 * Translate a v7 operation document (operations and fragments) into a native one.
 *
 * - `translated`: `output` is the native document; `# cyphra:` comments (unless `comments:
 *   false`) list what the translation dropped or does differently.
 * - `blocked`: something has no native equivalent; `output` is the source with `# cyphra: not
 *   translated: …` comments above the definitions concerned.
 * - `native` (already migrated) and `invalid` (neither API's document): `output` is the source.
 *
 * @experimental
 */
export function translateDocument(
  ctx: MigrationContext,
  source: string,
  options: TranslateOptions = {},
): DocumentTranslation {
  const comments = options.comments ?? true;
  let doc: DocumentNode;
  try {
    doc = parse(source);
  } catch (err) {
    const issue: MigrationIssue = {
      kind: "blocking",
      message: `syntax error: ${(err as Error).message}`,
      loc: (err as { positions?: number[] }).positions?.[0],
    };
    return { status: "invalid", output: source, changed: false, definitions: [], issues: [issue] };
  }
  const v7Errors = validate(ctx.v7Schema, doc, RULES);
  if (v7Errors.length) {
    const nativeErrors = validate(ctx.nativeSchema, doc, RULES);
    if (!nativeErrors.length) {
      return { status: "native", output: source, changed: false, definitions: [], issues: [] };
    }
    const issue = errorIssue("does not validate against the v7 schema", v7Errors);
    return { status: "invalid", output: source, changed: false, definitions: [], issues: [issue] };
  }

  const t = new DocumentTranslator(ctx, doc);
  const fragments: FragmentDefinitionNode[] = [];
  const results: {
    def: DefinitionNode;
    node?: DefinitionNode;
    issues: Issues;
    map?: DefinitionTranslation["mapData"];
  }[] = [];
  // Fragments first: operations map their results through the fragments' mappers.
  for (const def of doc.definitions) {
    if (def.kind !== Kind.FRAGMENT_DEFINITION) continue;
    const issues = t.reset();
    const node = t.fragment(def);
    if (node) fragments.push(node);
    results.push({ def, node, issues });
  }
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    const issues = t.reset();
    const { node, map } = t.operation(def);
    results.push({
      def,
      node: node && !issues.blocked ? retypeVariables(ctx, node, fragments, issues) : node,
      issues,
      map,
    });
  }
  // Validate the translation as a whole against the native schema.
  if (!results.some((r) => r.issues.blocked)) {
    const translated: DocumentNode = {
      kind: Kind.DOCUMENT,
      definitions: results.map((r) => r.node!).filter(Boolean),
    };
    const errors = validate(ctx.nativeSchema, translated, RULES);
    if (errors.length) {
      const first = results.find((r) => r.def.kind === Kind.OPERATION_DEFINITION) ?? results[0]!;
      const issue = errorIssue(
        "the translation does not validate against the native schema",
        errors,
      );
      first.issues.add(issue.kind, issue.message, first.def.loc?.start);
    }
  }
  const blocked = results.some((r) => r.issues.blocked);
  const sorted = [...results].sort((a, b) => (a.def.loc?.start ?? 0) - (b.def.loc?.start ?? 0));

  let output = "";
  let cursor = 0;
  for (const r of sorted) {
    const start = r.def.loc!.start;
    const end = r.def.loc!.end;
    const blockStart = commentBlockStart(source, start);
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const indent = /^\s*/.exec(source.slice(lineStart, start))![0];
    output += source.slice(cursor, blockStart);
    const shown = blocked ? r.issues.list.filter((i) => i.kind === "blocking") : r.issues.list;
    if (comments && shown.length) output += commentLines(shown, indent);
    output += source.slice(lineStart, start);
    if (blocked || !r.node) output += source.slice(start, end);
    else output += print(r.node).split("\n").join(`\n${indent}`);
    cursor = end;
  }
  output += source.slice(cursor);

  const definitions: DefinitionTranslation[] = sorted.map((r) => ({
    kind: r.def.kind === Kind.OPERATION_DEFINITION ? "operation" : "fragment",
    name: (r.def as OperationDefinitionNode | FragmentDefinitionNode).name?.value,
    loc: r.def.loc!.start,
    issues: r.issues.list,
    mapData: blocked ? undefined : r.map,
  }));
  return {
    status: blocked ? "blocked" : "translated",
    output,
    changed: output !== source,
    definitions,
    issues: definitions.flatMap((d) => d.issues),
  };
}

function errorIssue(what: string, errors: readonly GraphQLError[]): MigrationIssue {
  const shown = errors
    .slice(0, 3)
    .map((e) => e.message)
    .join("; ");
  return {
    kind: "blocking",
    message: `${what}: ${shown}${errors.length > 3 ? ` (and ${errors.length - 3} more)` : ""}`,
    loc: errors[0]?.locations?.[0] ? undefined : undefined,
  };
}

/** Whether a v7 node type is an interface (for callers that only have the name). */
export function isV7Interface(ctx: MigrationContext, name: string): boolean {
  const n = ctx.v7Node(name);
  return Boolean(n && isInterface(n));
}
