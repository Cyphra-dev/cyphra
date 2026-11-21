/**
 * Compiles v7 root mutation fields (`createMovies`, `updateMovies`, `deleteMovies`) with their
 * nested writes and the response selection into one Cypher statement each.
 *
 * Semantics follow `@neo4j/graphql` 7.6 (checked by the compatibility suite):
 * - `create`: every input becomes a node (`@id` fields get `randomUUID()`, `@timestamp` fields with
 *   the CREATE operation `datetime()`; `@default` values come from the input defaults); nested
 *   `create` runs before nested `connect`;
 * - `update`: scalar operators (`set`, `add`, `subtract`, `multiply`, `divide`, `push`, `pop` and the
 *   deprecated `field_SET`, `field_INCREMENT`, …) are applied first, with UPDATE `@timestamp`
 *   fields; then each relationship field, element by element, in the v7 order `update`, `create`,
 *   `connect`, `delete`, `disconnect`. Nested `update` also refreshes the UPDATE timestamps of the
 *   related node and of the edge;
 * - `connect` creates a relationship to every node matching `where` (like v7 it is a `CREATE`, not a
 *   `MERGE`: connecting an already connected pair adds a second relationship), and does not fill
 *   `@id` / `@timestamp` edge properties (v7 only does on nested `create`);
 * - `disconnect` deletes the matching relationships; `delete` deletes the matching nodes and,
 *   through nested `delete`, nodes related to them (all matched before anything is deleted);
 * - `info` counters are computed in the statement: nodes and relationships created by `CREATE`,
 *   relationships removed by `disconnect`, and the distinct nodes deleted with every relationship
 *   attached to them.
 *
 * The response (`movies { … }`) is projected with the read compiler after every write of the
 * statement (the `collect` before the projection waits for all of them).
 *
 * @packageDocumentation
 */

import { GraphQLError, type FieldNode } from "graphql";
import { isInt } from "neo4j-driver";
import { FOLLOW_UP, notImplemented } from "../errors.js";
import type { Attribute, NodeType, PropertiesType, Relationship, V7Model } from "../model.js";
import { labels, q, type CypherContext } from "./context.js";
import { collectFields, subSelections, SelectionCompiler, type SelectionInfo } from "./select.js";
import { castValue, encodeValue, relationshipPattern, valueExpr, WhereCompiler } from "./where.js";

type AnyRecord = Record<string, unknown>;

export type CompiledMutation = {
  readonly cypher: string;
  readonly params: Record<string, unknown>;
  /**
   * Turns the returned records (`this` column) into the field's GraphQL value. Runs inside the
   * transaction: it throws (and the transaction is rolled back) when a v7 check failed.
   */
  readonly decode: (rows: readonly unknown[]) => unknown;
};

type Counter = "nc" | "nd" | "rc" | "rd";
const COUNTER_KEYS: Record<string, Counter> = {
  nodesCreated: "nc",
  nodesDeleted: "nd",
  relationshipsCreated: "rc",
  relationshipsDeleted: "rd",
};
const ALL_COUNTERS: readonly Counter[] = ["nc", "nd", "rc", "rd"];

/** Order v7 applies the operations of one `${Source}${Rel}UpdateFieldInput` element in. */
const ELEMENT_OPERATIONS = ["update", "create", "connect", "delete", "disconnect"] as const;

const LEGACY_UPDATE_OPERATORS: Record<string, string> = {
  SET: "set",
  PUSH: "push",
  POP: "pop",
  INCREMENT: "add",
  DECREMENT: "subtract",
  ADD: "add",
  SUBTRACT: "subtract",
  MULTIPLY: "multiply",
  DIVIDE: "divide",
};

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asList(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * The clauses of one (sub)query and, per counter, the expressions each of its rows adds. A block
 * becomes `CALL (imports) { <clauses> RETURN {nc: sum(…), …} AS count }`: the aggregation keeps
 * exactly one row per outer row, whatever the block matched.
 */
class Block {
  readonly clauses: string[] = [];
  readonly terms: Record<Counter, string[]> = { nc: [], nd: [], rc: [], rd: [] };
  /** Per row: lists of the error messages of failed checks (see `checkExpr`). */
  readonly errors: string[] = [];

  add(clause: string): void {
    this.clauses.push(clause);
  }

  count(counter: Counter, term: string): void {
    this.terms[counter].push(term);
  }

  /** Checks evaluated on each row after the writes: `CASE WHEN … THEN <message> END`. */
  check(checks: readonly string[]): void {
    if (checks.length) this.errors.push(`[x IN [${checks.join(", ")}] WHERE x IS NOT NULL]`);
  }

  hasCounts(): boolean {
    return this.errors.length > 0 || ALL_COUNTERS.some((k) => this.terms[k].length > 0);
  }

  /** `{ nc: sum(…), …, errors: … }` over the rows of the block (`aggregate`), or of its one row. */
  aggregate(aggregate = true): string {
    const total = (k: Counter) => this.terms[k].join(" + ") || "0";
    const items = ALL_COUNTERS.map((k) => `${k}: ${aggregate ? `sum(${total(k)})` : total(k)}`);
    if (this.errors.length) {
      const errors = this.errors.join(" + ");
      items.push(
        `errors: ${aggregate ? `reduce(acc = [], l IN collect(${errors}) | acc + l)` : errors}`,
      );
    }
    return `{ ${items.join(", ")} }`;
  }
}

function indent(lines: readonly string[]): string {
  return lines
    .join("\n")
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

/** `(from)<-[r:TYPE]-(to)` between bound variables. */
function edgePattern(from: string, rel: Relationship, relVar: string, to: string): string {
  const edge = `[${relVar}:${q(rel.type)}]`;
  return rel.direction === "OUT" ? `(${from})-${edge}->(${to})` : `(${from})<-${edge}-(${to})`;
}

/** Value of a generated property (`@id`, `@timestamp`). */
function generatedValue(a: Attribute): string {
  if (a.id) return "randomUUID()";
  return a.type.name === "Date" ? "date()" : "datetime()";
}

function onCreateGenerated(variable: string, attributes: readonly Attribute[]): string[] {
  return attributes
    .filter((a) => !a.cypher && (a.id || a.timestamp?.includes("CREATE")))
    .map((a) => `${variable}.${q(a.property)} = ${generatedValue(a)}`);
}

function onUpdateGenerated(variable: string, attributes: readonly Attribute[]): string[] {
  return attributes
    .filter((a) => !a.cypher && !a.id && a.timestamp?.includes("UPDATE"))
    .map((a) => `${variable}.${q(a.property)} = ${generatedValue(a)}`);
}

/** `{ <response key>: count }` for the selected `info` / `DeleteInfo` fields. */
function decodeCounts(
  fields: readonly (readonly [key: string, field: string])[],
  counts: AnyRecord,
): AnyRecord {
  return Object.fromEntries(
    fields
      .filter(([, f]) => f in COUNTER_KEYS)
      .map(([k, f]) => {
        const v = counts[COUNTER_KEYS[f]!] ?? 0;
        return [k, isInt(v) ? v.toNumber() : Number(v)];
      }),
  );
}

export class MutationCompiler {
  private readonly select: SelectionCompiler;
  private readonly where: WhereCompiler;
  private readonly ctx: CypherContext;

  constructor(
    private readonly model: V7Model,
    private readonly info: SelectionInfo,
  ) {
    this.select = new SelectionCompiler(model, info);
    this.ctx = this.select.ctx;
    this.where = new WhereCompiler(model, this.ctx, (n) => this.select.assertReadable(n));
  }

  private assertWritable(node: NodeType): void {
    if (node.auth.authorization || node.auth.authentication?.length) {
      throw notImplemented(
        `writing ${node.name}, which has @authentication / @authorization rules`,
        FOLLOW_UP.authorization,
      );
    }
  }

  private props(rel: Relationship): PropertiesType | undefined {
    return rel.properties ? this.model.properties.get(rel.properties) : undefined;
  }

  private relationship(node: NodeType, name: string): Relationship {
    const rel = node.relationships.find((r) => r.name === name);
    if (!rel) throw new Error(`Unknown relationship ${node.name}.${name}`);
    return rel;
  }

  /** Runs `inner` once per row of `outer` (`CALL (imports) { … }`) and adds its counts. */
  private call(outer: Block, imports: readonly string[], inner: Block): void {
    if (outer.clauses.length) outer.add("WITH *");
    if (!inner.hasCounts()) {
      // Unit subquery: no counts to return, and it keeps the outer rows as they are.
      outer.add(`CALL (${imports.join(", ")}) {\n${indent(inner.clauses)}\n}`);
      return;
    }
    const c = this.ctx.variable("count");
    outer.add(
      `CALL (${imports.join(", ")}) {\n${indent(inner.clauses)}\n  RETURN ${inner.aggregate()} AS ${c}\n}`,
    );
    for (const k of ALL_COUNTERS) if (inner.terms[k].length) outer.count(k, `${c}.${k}`);
    if (inner.errors.length) outer.errors.push(`${c}.errors`);
  }

  /** `SET` items for the attribute keys of a create input. */
  private createAssignments(
    variable: string,
    attributes: readonly Attribute[],
    input: unknown,
    owner: string,
    relationships: readonly Relationship[] = [],
  ): string[] {
    const sets: string[] = [];
    if (!isPlainObject(input)) return sets;
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || relationships.some((r) => r.name === key)) continue;
      const a = attributes.find((x) => x.name === key);
      if (!a) throw new Error(`Unknown field ${owner}CreateInput.${key}`);
      sets.push(`${variable}.${q(a.property)} = ${valueExpr(this.ctx, a, value, a.type.list)}`);
    }
    return sets;
  }

  /** `SET` items for the scalar operators of an update input (`{ set }`, `{ add }`, `title_SET`, …). */
  private updateAssignments(
    variable: string,
    attributes: readonly Attribute[],
    input: unknown,
    owner: string,
    checks: string[],
    relationships: readonly Relationship[] = [],
  ): string[] {
    if (!isPlainObject(input)) return [];
    const byAttribute = new Map<
      Attribute,
      { keys: string[]; ops: [op: string, label: string, value: unknown][] }
    >();
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || relationships.some((r) => r.name === key)) continue;
      let attr = attributes.find((a) => a.name === key);
      let ops: [string, string, unknown][];
      if (attr) {
        if (!isPlainObject(value)) continue;
        ops = Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .map(([op, v]) => [op, op, v]);
      } else {
        const m = /^(.+)_([A-Z]+)$/.exec(key);
        attr = m ? attributes.find((a) => a.name === m[1]) : undefined;
        const op = m ? LEGACY_UPDATE_OPERATORS[m[2]!] : undefined;
        if (!attr || !op) throw new Error(`Unknown field ${owner}UpdateInput.${key}`);
        ops = [[op, m![2]!.toLowerCase(), value]];
      }
      const entry = byAttribute.get(attr) ?? { keys: [], ops: [] };
      entry.keys.push(key);
      entry.ops.push(...ops);
      byAttribute.set(attr, entry);
    }
    const sets: string[] = [];
    for (const [attr, { keys, ops }] of byAttribute) {
      if (keys.length > 1) {
        throw new GraphQLError(
          `Conflicting modification of ${keys.map((k) => `[[${k}]]`).join(", ")} on type ${owner}`,
        );
      }
      const prop = `${variable}.${q(attr.property)}`;
      for (const [op, label, value] of ops) {
        sets.push(`${prop} = ${this.updateExpr(prop, attr, op, value)}`);
        const check = this.checkExpr(prop, attr, op, label, value);
        if (check) checks.push(check);
      }
    }
    return sets;
  }

  /**
   * The v7 checks of an operator, evaluated on the written value (v7 runs them with APOC; here the
   * statement returns the messages and the transaction is rolled back): arithmetic on a missing
   * value, Int results beyond 32 bits, `push` / `pop` on a missing list.
   */
  private checkExpr(
    prop: string,
    attr: Attribute,
    op: string,
    label: string,
    value: unknown,
  ): string | undefined {
    const type = attr.type.name;
    if (op === "push" || op === "pop") {
      return `CASE WHEN ${prop} IS NULL THEN ${this.ctx.param(`Property ${attr.name} cannot be NULL`)} END`;
    }
    if (!["add", "subtract", "multiply", "divide"].includes(op)) return undefined;
    const shown = isInt(value)
      ? value.toString()
      : type === "Float" && typeof value === "number" && Number.isInteger(value)
        ? `${value}.0`
        : String(value);
    const whens = [
      `WHEN ${prop} IS NULL THEN ${this.ctx.param(`Cannot ${label} ${shown} to Nan`)}`,
    ];
    if (type === "Int") {
      whens.push(
        `WHEN ${prop} > 2147483647 THEN ${this.ctx.param(`Overflow: Value returned from operator ${label} is larger than 32 bit`)}`,
      );
    }
    return `CASE ${whens.join(" ")} END`;
  }

  private updateExpr(prop: string, attr: Attribute, op: string, value: unknown): string {
    switch (op) {
      case "set":
        return valueExpr(this.ctx, attr, value, attr.type.list);
      case "push":
        return `${prop} + ${valueExpr(this.ctx, attr, asList(value), true)}`;
      case "pop":
        return `${prop}[0..-${this.ctx.param(encodeValue(intAttribute, value))}]`;
      case "add":
        return `(${prop} + ${valueExpr(this.ctx, attr, value, false)})`;
      case "subtract":
        return `(${prop} - ${valueExpr(this.ctx, attr, value, false)})`;
      case "multiply":
        return `(${prop} * ${valueExpr(this.ctx, attr, value, false)})`;
      case "divide":
        return `(${prop} / ${valueExpr(this.ctx, attr, value, false)})`;
    }
    throw new Error(`Unsupported update operator ${op}`);
  }

  // ---------------------------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------------------------

  /** `CREATE (v:Label) SET …` and the nested writes of a `${Node}CreateInput`. */
  private createNode(
    block: Block,
    v: string,
    node: NodeType,
    input: unknown,
    afterCreate?: () => void,
  ): void {
    this.assertWritable(node);
    block.add(`CREATE (${v}${labels(node.labels)})`);
    const sets = [
      ...onCreateGenerated(v, node.attributes),
      ...this.createAssignments(v, node.attributes, input, node.name, node.relationships),
    ];
    if (sets.length) block.add(`SET ${sets.join(", ")}`);
    block.count("nc", "1");
    afterCreate?.();
    if (!isPlainObject(input)) return;
    for (const rel of node.relationships) {
      const field = input[rel.name];
      if (!isPlainObject(field)) continue;
      for (const el of asList(field.create)) this.nestedCreate(block, v, rel, el);
      for (const el of asList(field.connect)) this.connect(block, v, rel, el);
    }
  }

  /** `{ node, edge }` of a relationship `create`: a new related node and the edge to it. */
  private nestedCreate(block: Block, from: string, rel: Relationship, el: unknown): void {
    if (!isPlainObject(el)) return;
    const target = this.model.node(rel.target);
    const inner = new Block();
    const t = this.ctx.variable("this");
    const r = this.ctx.variable("edge");
    this.createNode(inner, t, target, el.node, () => {
      inner.add(`CREATE ${edgePattern(from, rel, r, t)}`);
      const props = this.props(rel);
      if (props) {
        const sets = [
          ...onCreateGenerated(r, props.attributes),
          ...this.createAssignments(r, props.attributes, el.edge, props.name),
        ];
        if (sets.length) inner.add(`SET ${sets.join(", ")}`);
      }
      inner.count("rc", "1");
    });
    this.call(block, [from], inner);
  }

  /** `{ where, edge, connect }`: an edge to every node matching `where` (then nested connects). */
  private connect(block: Block, from: string, rel: Relationship, el: unknown): void {
    if (!isPlainObject(el)) return;
    const target = this.model.node(rel.target);
    this.assertWritable(target);
    const inner = new Block();
    const t = this.ctx.variable("this");
    const where = isPlainObject(el.where) ? el.where.node : undefined;
    const pred = this.where.node(t, target, where);
    inner.add(`MATCH (${t}${labels(target.labels)})${pred ? ` WHERE ${pred}` : ""}`);
    for (const nested of asList(el.connect)) {
      if (!isPlainObject(nested)) continue;
      for (const [name, els] of Object.entries(nested)) {
        const rel2 = this.relationship(target, name);
        for (const e of asList(els)) this.connect(inner, t, rel2, e);
      }
    }
    const r = this.ctx.variable("edge");
    inner.add(`CREATE ${edgePattern(from, rel, r, t)}`);
    const props = this.props(rel);
    if (props) {
      const sets = this.createAssignments(r, props.attributes, el.edge, props.name);
      if (sets.length) inner.add(`SET ${sets.join(", ")}`);
    }
    inner.count("rc", "1");
    this.call(block, [from], inner);
  }

  // ---------------------------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------------------------

  /** The relationship operations of a `${Node}UpdateInput` on `v`. */
  private updateRelationships(block: Block, v: string, node: NodeType, input: unknown): void {
    if (!isPlainObject(input)) return;
    for (const [key, value] of Object.entries(input)) {
      const rel = node.relationships.find((r) => r.name === key);
      if (!rel || value === null || value === undefined) continue;
      for (const el of asList(value)) {
        if (!isPlainObject(el)) continue;
        for (const op of ELEMENT_OPERATIONS) {
          const arg = el[op];
          if (arg === null || arg === undefined) continue;
          switch (op) {
            case "update":
              this.nestedUpdate(block, v, rel, arg);
              break;
            case "create":
              for (const e of asList(arg)) this.nestedCreate(block, v, rel, e);
              break;
            case "connect":
              for (const e of asList(arg)) this.connect(block, v, rel, e);
              break;
            case "delete":
              for (const e of asList(arg)) this.nestedDelete(block, v, rel, e);
              break;
            case "disconnect":
              for (const e of asList(arg)) this.disconnect(block, v, rel, e);
              break;
          }
        }
      }
    }
  }

  /** `{ where, node, edge }`: updates the related nodes (and edges) matching `where`. */
  private nestedUpdate(block: Block, from: string, rel: Relationship, el: unknown): void {
    if (!isPlainObject(el)) return;
    const target = this.model.node(rel.target);
    this.assertWritable(target);
    const props = this.props(rel);
    const inner = new Block();
    const t = this.ctx.variable("this");
    const r = this.ctx.variable("edge");
    const pred = this.where.connection(r, t, rel, el.where);
    inner.add(
      `MATCH ${relationshipPattern(this.model, from, rel, t, r)}${pred ? ` WHERE ${pred}` : ""}`,
    );
    const checks: string[] = [];
    const sets = [
      ...onUpdateGenerated(t, target.attributes),
      ...(props ? onUpdateGenerated(r, props.attributes) : []),
      ...this.updateAssignments(
        t,
        target.attributes,
        el.node,
        target.name,
        checks,
        target.relationships,
      ),
      ...(props ? this.updateAssignments(r, props.attributes, el.edge, props.name, checks) : []),
    ];
    if (sets.length) inner.add(`SET ${sets.join(", ")}`);
    inner.check(checks);
    this.updateRelationships(inner, t, target, el.node);
    if (!inner.hasCounts() && inner.clauses.length === 1) return;
    this.call(block, [from], inner);
  }

  /** `{ where, disconnect }`: deletes the matching relationships (then nested disconnects). */
  private disconnect(block: Block, from: string, rel: Relationship, el: unknown): void {
    if (!isPlainObject(el)) return;
    const target = this.model.node(rel.target);
    this.assertWritable(target);
    const inner = new Block();
    const t = this.ctx.variable("this");
    const r = this.ctx.variable("edge");
    const pred = this.where.connection(r, t, rel, el.where);
    inner.add(
      `MATCH ${relationshipPattern(this.model, from, rel, t, r)}${pred ? ` WHERE ${pred}` : ""}`,
    );
    if (isPlainObject(el.disconnect)) {
      for (const [name, els] of Object.entries(el.disconnect)) {
        const rel2 = this.relationship(target, name);
        for (const e of asList(els)) this.disconnect(inner, t, rel2, e);
      }
    }
    if (inner.clauses.length > 1) inner.add("WITH *");
    inner.add(`DELETE ${r}`);
    inner.count("rd", "1");
    this.call(block, [from], inner);
  }

  // ---------------------------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------------------------

  /**
   * `COLLECT { … }` lists of the nodes a `{ where, delete }` element deletes: the related nodes
   * matching `where` and, through nested `delete`, nodes related to them. `match` is the chain of
   * `MATCH … WHERE …` that binds `t`.
   */
  private deleteLists(match: string, t: string, node: NodeType, del: unknown): string[] {
    this.assertWritable(node);
    const lists = [`COLLECT { ${match} RETURN DISTINCT ${t} }`];
    if (!isPlainObject(del)) return lists;
    for (const [name, els] of Object.entries(del)) {
      const rel = this.relationship(node, name);
      const target = this.model.node(rel.target);
      for (const el of asList(els)) {
        if (!isPlainObject(el)) continue;
        const u = this.ctx.variable("this");
        const r = this.ctx.variable("edge");
        const pred = this.where.connection(r, u, rel, el.where);
        const chain = `${match} MATCH ${relationshipPattern(this.model, t, rel, u, r)}${pred ? ` WHERE ${pred}` : ""}`;
        lists.push(...this.deleteLists(chain, u, target, el.delete));
      }
    }
    return lists;
  }

  /**
   * Deletes the distinct nodes of `list` with their relationships, counting both
   * (`WITH … AS deleted, COUNT { … } AS …`, then `FOREACH … DETACH DELETE`).
   */
  private deleteNodes(block: Block, list: string, keep: readonly string[]): void {
    const d = this.ctx.variable("deleted");
    const x = this.ctx.variable("node");
    const e = this.ctx.variable("rel");
    const n = this.ctx.variable("relCount");
    const kept = keep.length ? `${keep.join(", ")}, ` : "";
    block.add(`WITH ${kept}COLLECT { UNWIND ${list} AS ${x} RETURN DISTINCT ${x} } AS ${d}`);
    block.add(
      `WITH ${kept}${d}, COUNT { UNWIND ${d} AS ${x} MATCH (${x})-[${e}]-() RETURN DISTINCT ${e} } AS ${n}`,
    );
    block.add(`FOREACH (${x} IN ${d} | DETACH DELETE ${x})`);
    block.count("nd", `size(${d})`);
    block.count("rd", n);
  }

  /** `{ where, delete }` inside an update: deletes the matching related nodes. */
  private nestedDelete(block: Block, from: string, rel: Relationship, el: unknown): void {
    if (!isPlainObject(el)) return;
    const target = this.model.node(rel.target);
    const t = this.ctx.variable("this");
    const r = this.ctx.variable("edge");
    const pred = this.where.connection(r, t, rel, el.where);
    const match = `MATCH ${relationshipPattern(this.model, from, rel, t, r)}${pred ? ` WHERE ${pred}` : ""}`;
    const lists = this.deleteLists(match, t, target, el.delete);
    const inner = new Block();
    this.deleteNodes(inner, `(${lists.join(" + ")})`, []);
    this.call(block, [from], inner);
  }

  // ---------------------------------------------------------------------------------------------
  // Root fields
  // ---------------------------------------------------------------------------------------------

  /**
   * `WITH <nodes> AS nodes, <info>`, the projections of the response's node list (one per response
   * key) and the decoder of the `{ info, <plural> }` response.
   */
  private response(
    block: Block,
    nodes: string,
    info: string,
    node: NodeType,
    fieldNodes: readonly FieldNode[],
  ): CompiledMutation {
    const list = this.ctx.variable("nodes");
    block.add(`WITH ${nodes} AS ${list}, ${info} AS info`);
    const entries: string[] = [];
    const decoders: [string, (raw: AnyRecord) => unknown][] = [];
    for (const [key, nodesOfKey] of collectFields(this.info, subSelections(fieldNodes))) {
      const name = nodesOfKey[0]!.name.value;
      if (name === "info") {
        const fields = [...collectFields(this.info, subSelections(nodesOfKey))].map(
          ([k, n]) => [k, n[0]!.name.value] as const,
        );
        decoders.push([
          key,
          (raw) => {
            const counts = (raw.info ?? {}) as AnyRecord;
            return decodeCounts(fields, counts);
          },
        ]);
      } else if (name === node.plural) {
        const v = this.ctx.variable("this");
        const d = this.ctx.variable("data");
        const proj = this.select.projectNode(v, node, nodesOfKey);
        block.add(
          `CALL (${list}) {\n  UNWIND ${list} AS ${v}\n  RETURN collect(${proj.expr}) AS ${d}\n}`,
        );
        entries.push(`${q(key)}: ${d}`);
        decoders.push([
          key,
          (raw) => {
            const data = ((raw.data ?? {}) as AnyRecord)[key];
            return Array.isArray(data) ? data.map(proj.decode) : [];
          },
        ]);
      }
    }
    const data = entries.length ? `{ ${entries.join(", ")} }` : "{}";
    block.add(`RETURN { info: info, data: ${data} } AS this`);
    return {
      cypher: block.clauses.join("\n"),
      params: this.ctx.params,
      decode: (rows) => {
        const raw = (rows[0] ?? {}) as AnyRecord;
        const errors = ((raw.info ?? {}) as AnyRecord).errors;
        if (Array.isArray(errors) && errors.length) throw new GraphQLError(String(errors[0]));
        return Object.fromEntries(decoders.map(([k, dec]) => [k, dec(raw)]));
      },
    };
  }

  /** `createMovies(input: [...])`. */
  rootCreate(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): CompiledMutation {
    this.assertWritable(node);
    const block = new Block();
    const groups: string[] = [];
    const inputs = asList(args.input);
    let i = 0;
    while (i < inputs.length) {
      // Consecutive inputs without relationship fields share one `UNWIND`.
      let j = i;
      while (j < inputs.length && !this.hasRelationshipInput(node, inputs[j])) j++;
      if (j > i) {
        groups.push(this.createFlat(block, node, inputs.slice(i, j)));
        i = j;
        continue;
      }
      const inner = new Block();
      const v = this.ctx.variable("this");
      this.createNode(inner, v, node, inputs[i]);
      const g = this.ctx.variable("created");
      const c = this.ctx.variable("count");
      block.add(
        `CALL () {\n${indent(inner.clauses)}\n  RETURN collect(${v}) AS ${g}, ${inner.aggregate()} AS ${c}\n}`,
      );
      for (const k of ALL_COUNTERS) if (inner.terms[k].length) block.count(k, `${c}.${k}`);
      if (inner.errors.length) block.errors.push(`${c}.errors`);
      groups.push(g);
      i++;
    }
    return this.response(
      block,
      groups.length ? groups.join(" + ") : "[]",
      block.aggregate(false),
      node,
      fieldNodes,
    );
  }

  private hasRelationshipInput(node: NodeType, input: unknown): boolean {
    return (
      isPlainObject(input) &&
      node.relationships.some((r) => input[r.name] !== undefined && input[r.name] !== null)
    );
  }

  /** `UNWIND $rows AS row CREATE (n:Label) SET n.p = row.p, …` for inputs without relationships. */
  private createFlat(block: Block, node: NodeType, inputs: readonly unknown[]): string {
    const keys = new Set<string>();
    for (const input of inputs) {
      if (!isPlainObject(input)) continue;
      for (const [k, v] of Object.entries(input)) if (v !== undefined) keys.add(k);
    }
    const attrs = [...keys].map((k) => {
      const a = node.attributes.find((x) => x.name === k);
      if (!a) throw new Error(`Unknown field ${node.name}CreateInput.${k}`);
      return a;
    });
    const rows = inputs.map((input) => {
      const r = isPlainObject(input) ? input : {};
      return Object.fromEntries(attrs.map((a) => [a.name, encodeValue(a, r[a.name])]));
    });
    const row = this.ctx.variable("row");
    const v = this.ctx.variable("this");
    const g = this.ctx.variable("created");
    const sets = [
      ...onCreateGenerated(v, node.attributes),
      ...attrs.map(
        (a) => `${v}.${q(a.property)} = ${castValue(a, `${row}.${q(a.name)}`, a.type.list)}`,
      ),
    ];
    const lines = [
      `UNWIND ${this.ctx.param(rows)} AS ${row}`,
      `CREATE (${v}${labels(node.labels)})`,
      ...(sets.length ? [`SET ${sets.join(", ")}`] : []),
      `RETURN collect(${v}) AS ${g}`,
    ];
    block.add(`CALL () {\n${indent(lines)}\n}`);
    block.count("nc", `size(${g})`);
    return g;
  }

  /** `updateMovies(where, update)`; without `update` it only reads (and refreshes UPDATE timestamps). */
  rootUpdate(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): CompiledMutation {
    this.assertWritable(node);
    const block = new Block();
    const v = this.ctx.variable("this");
    const pred = this.where.node(v, node, args.where);
    block.add(`MATCH (${v}${labels(node.labels)})${pred ? `\nWHERE ${pred}` : ""}`);
    // v7 refreshes UPDATE timestamps even without an `update` argument.
    const checks: string[] = [];
    const sets = [
      ...onUpdateGenerated(v, node.attributes),
      ...this.updateAssignments(
        v,
        node.attributes,
        args.update,
        node.name,
        checks,
        node.relationships,
      ),
    ];
    if (sets.length) block.add(`SET ${sets.join(", ")}`);
    block.check(checks);
    this.updateRelationships(block, v, node, args.update);
    return this.response(block, `collect(${v})`, block.aggregate(), node, fieldNodes);
  }

  /** `deleteMovies(where, delete)`: one `DeleteInfo`. */
  rootDelete(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): CompiledMutation {
    this.assertWritable(node);
    const block = new Block();
    const v = this.ctx.variable("this");
    const pred = this.where.node(v, node, args.where);
    block.add(`MATCH (${v}${labels(node.labels)})${pred ? `\nWHERE ${pred}` : ""}`);
    const roots = this.ctx.variable("roots");
    const nested: string[] = [];
    if (isPlainObject(args.delete)) {
      for (const [name, els] of Object.entries(args.delete)) {
        const rel = this.relationship(node, name);
        const target = this.model.node(rel.target);
        for (const el of asList(els)) {
          if (!isPlainObject(el)) continue;
          const t = this.ctx.variable("this");
          const r = this.ctx.variable("edge");
          const p = this.where.connection(r, t, rel, el.where);
          const match = `MATCH ${relationshipPattern(this.model, v, rel, t, r)}${p ? ` WHERE ${p}` : ""}`;
          nested.push(...this.deleteLists(match, t, target, el.delete));
        }
      }
    }
    let list: string;
    if (nested.length) {
      const related = this.ctx.variable("related");
      block.add(`WITH collect(${v}) AS ${roots}, collect(${nested.join(" + ")}) AS ${related}`);
      list = `(${roots} + reduce(acc = [], l IN ${related} | acc + l))`;
    } else {
      block.add(`WITH collect(${v}) AS ${roots}`);
      list = roots;
    }
    this.deleteNodes(block, list, []);
    const fields = [...collectFields(this.info, subSelections(fieldNodes))].map(
      ([k, n]) => [k, n[0]!.name.value] as const,
    );
    block.add(`RETURN ${block.aggregate(false)} AS this`);
    return {
      cypher: block.clauses.join("\n"),
      params: this.ctx.params,
      decode: (rows) => {
        const counts = (rows[0] ?? {}) as AnyRecord;
        return decodeCounts(fields, counts);
      },
    };
  }
}

/** The `pop` count is an Int. */
const intAttribute: Attribute = {
  name: "pop",
  property: "pop",
  type: { name: "Int", list: false, required: true, elementRequired: false },
  kind: "scalar",
  id: false,
};
