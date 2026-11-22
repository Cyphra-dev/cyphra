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
 * - relationships to unions take member-keyed inputs (`favorites: { Movie: { create, connect },
 *   Book: … }`, `delete: { favorites: { Movie: [{ where }] } }`, …): each member key runs the nested
 *   operations of a relationship to that member;
 * - `info` counters are computed in the statement: nodes and relationships created by `CREATE`,
 *   relationships removed by `disconnect`, and the distinct nodes deleted with every relationship
 *   attached to them.
 *
 * The response (`movies { … }`) is projected with the read compiler after every write of the
 * statement (the `collect` before the projection waits for all of them).
 *
 * Authorization (v7 7.6): `@authentication` is checked before the statement is built. `filter` rules
 * restrict the nodes an operation matches (UPDATE, DELETE, CREATE_RELATIONSHIP and
 * DELETE_RELATIONSHIP on the target of `connect` / `disconnect`). `validate` rules are evaluated in
 * the statement: BEFORE checks right after the match (captured before any write), AFTER checks once
 * the node's writes (nested ones included) are done; for `connect` / `disconnect` the source node is
 * checked too (AFTER only for `connect`, like v7). A failed check makes the statement return its
 * message: the decoder throws `Forbidden` inside the transaction, which is rolled back, and the
 * response data of that statement is not returned. The update response applies the READ rules to
 * the updated nodes; the create response does not (v7), its nested selections do.
 *
 * @packageDocumentation
 */

import { GraphQLError, type FieldNode } from "graphql";
import { isInt } from "neo4j-driver";
import { checkAuthentication, type AuthContext } from "../auth/context.js";
import type { AuthRules } from "../auth/rules.js";
import {
  isUnionRelationship,
  unionMembers,
  type Attribute,
  type AuthOperation,
  type NodeType,
  type PropertiesType,
  type Relationship,
  type V7Model,
} from "../model.js";
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
  private readonly rules: AuthRules;

  constructor(
    private readonly model: V7Model,
    private readonly info: SelectionInfo,
    private readonly auth: AuthContext,
  ) {
    this.select = new SelectionCompiler(model, info, auth);
    this.ctx = this.select.ctx;
    this.rules = this.select.rules;
    this.where = new WhereCompiler(model, this.ctx);
  }

  /** `@authentication` for `operation` on the type and on the written `fields`. */
  private authenticate(
    node: NodeType,
    operation: AuthOperation,
    fields: readonly string[] = [],
  ): void {
    checkAuthentication(this.model, this.auth, node, [operation]);
    for (const f of fields) checkAuthentication(this.model, this.auth, node, [operation], f);
  }

  /** Attributes written by a create / update input (`title`, `title_SET`, …). */
  private writtenAttributes(node: NodeType, input: unknown): Attribute[] {
    if (!isPlainObject(input)) return [];
    const out = new Set<Attribute>();
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const attr =
        node.attributes.find((a) => a.name === key) ??
        node.attributes.find(
          (a) =>
            key.startsWith(`${a.name}_`) && key.slice(a.name.length + 1) in LEGACY_UPDATE_OPERATORS,
        );
      if (attr) out.add(attr);
    }
    return [...out];
  }

  /**
   * Evaluates `check` (a `CASE WHEN … THEN 'Forbidden' END`) on the current rows and keeps its result
   * (`WITH *, … AS authN`), so a BEFORE check sees the graph as it was before the writes that follow.
   */
  private capture(block: Block, check: string | undefined): void {
    if (check === undefined) return;
    const v = this.ctx.variable("auth");
    block.add(`WITH *, ${check} AS ${v}`);
    block.check([v]);
  }

  private props(rel: Relationship): PropertiesType | undefined {
    return rel.properties ? this.model.properties.get(rel.properties) : undefined;
  }

  private relationship(node: NodeType, name: string): Relationship {
    const rel = node.relationships.find((r) => r.name === name);
    if (!rel) throw new Error(`Unknown relationship ${node.name}.${name}`);
    return rel;
  }

  /**
   * The elements of a relationship input with the relationship they apply to: the elements of
   * `value` (a list or one element), or for a relationship to a union, the elements of each member
   * key (`{ Movie: […], Book: […] }`) with the member's view of the relationship.
   */
  private elements(rel: Relationship, value: unknown): [Relationship, unknown][] {
    if (!isUnionRelationship(this.model, rel)) return asList(value).map((e) => [rel, e]);
    if (!isPlainObject(value)) return [];
    return unionMembers(this.model, rel).flatMap((m) =>
      asList(value[m.target]).map((e): [Relationship, unknown] => [m, e]),
    );
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
    const written = this.writtenAttributes(node, input);
    this.authenticate(
      node,
      "CREATE",
      written.map((a) => a.name),
    );
    block.add(`CREATE (${v}${labels(node.labels)})`);
    const sets = [
      ...onCreateGenerated(v, node.attributes),
      ...this.createAssignments(v, node.attributes, input, node.name, node.relationships),
    ];
    if (sets.length) block.add(`SET ${sets.join(", ")}`);
    block.count("nc", "1");
    afterCreate?.();
    if (isPlainObject(input)) {
      for (const rel of node.relationships) {
        for (const [r, field] of this.elements(rel, input[rel.name])) {
          if (!isPlainObject(field)) continue;
          for (const el of asList(field.create)) this.nestedCreate(block, v, r, el);
          for (const el of asList(field.connect)) this.connect(block, v, r, el);
        }
      }
    }
    // CREATE rules are AFTER rules (v7), checked once the nested writes are done.
    const after = this.rules.check(this.rules.fails(v, node, "CREATE", "AFTER", written));
    if (after) block.check([after]);
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
    const source = this.model.node(rel.source);
    this.authenticate(target, "CREATE_RELATIONSHIP");
    this.authenticate(source, "CREATE_RELATIONSHIP");
    const inner = new Block();
    const t = this.ctx.variable("this");
    const where = isPlainObject(el.where) ? el.where.node : undefined;
    const pred = and([
      this.where.node(t, target, where),
      this.rules.filter(t, target, "CREATE_RELATIONSHIP"),
    ]);
    inner.add(`MATCH (${t}${labels(target.labels)})${pred ? ` WHERE ${pred}` : ""}`);
    this.capture(
      inner,
      this.rules.check(this.rules.fails(t, target, "CREATE_RELATIONSHIP", "BEFORE")),
    );
    for (const nested of asList(el.connect)) {
      if (!isPlainObject(nested)) continue;
      for (const [name, els] of Object.entries(nested)) {
        for (const [rel2, e] of this.elements(this.relationship(target, name), els))
          this.connect(inner, t, rel2, e);
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
    const after = [
      this.rules.check(this.rules.fails(t, target, "CREATE_RELATIONSHIP", "AFTER")),
      this.rules.check(this.rules.fails(from, source, "CREATE_RELATIONSHIP", "AFTER")),
    ].filter((c): c is string => c !== undefined);
    if (after.length) inner.check(after);
    this.call(block, [from], inner);
  }

  // ---------------------------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------------------------

  /** The relationship operations of a `${Node}UpdateInput` on `v`. */
  private updateRelationships(block: Block, v: string, node: NodeType, input: unknown): void {
    if (!isPlainObject(input)) return;
    for (const [key, value] of Object.entries(input)) {
      const relationship = node.relationships.find((r) => r.name === key);
      if (!relationship || value === null || value === undefined) continue;
      for (const [rel, el] of this.elements(relationship, value)) {
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
    const written = this.writtenAttributes(target, el.node);
    this.authenticate(
      target,
      "UPDATE",
      written.map((a) => a.name),
    );
    // v7 applies the type's UPDATE rules when attributes or nested `update`s are written.
    const typeRules = written.length > 0 || this.hasNestedUpdate(target, el.node);
    const props = this.props(rel);
    const inner = new Block();
    const t = this.ctx.variable("this");
    const r = this.ctx.variable("edge");
    const pred = and([
      this.where.connection(r, t, rel, el.where),
      typeRules ? this.rules.filter(t, target, "UPDATE") : undefined,
    ]);
    inner.add(
      `MATCH ${relationshipPattern(this.model, from, rel, t, r)}${pred ? ` WHERE ${pred}` : ""}`,
    );
    this.capture(inner, this.updateCheck(t, target, "BEFORE", written, typeRules));
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
    const after = this.updateCheck(t, target, "AFTER", written, typeRules);
    if (after) inner.check([after]);
    if (!inner.hasCounts() && inner.clauses.length === 1) return;
    this.call(block, [from], inner);
  }

  /** Whether an update input has a nested `update` on one of its relationships. */
  private hasNestedUpdate(node: NodeType, input: unknown): boolean {
    if (!isPlainObject(input)) return false;
    return node.relationships.some((rel) =>
      this.elements(rel, input[rel.name]).some(
        ([, el]) => isPlainObject(el) && el.update !== undefined && el.update !== null,
      ),
    );
  }

  /** UPDATE `validate` check: the type's rules (when they apply) and the written attributes' rules. */
  private updateCheck(
    v: string,
    node: NodeType,
    when: "BEFORE" | "AFTER",
    written: readonly Attribute[],
    typeRules: boolean,
  ): string | undefined {
    const validations = [
      ...(typeRules ? this.rules.validations(v, node, "UPDATE", when) : []),
      ...written.flatMap((a) =>
        this.rules.validations(v, { ...node, auth: {} }, "UPDATE", when, [a]),
      ),
    ];
    return this.rules.check(this.rules.failure(validations));
  }

  /** `{ where, disconnect }`: deletes the matching relationships (then nested disconnects). */
  private disconnect(block: Block, from: string, rel: Relationship, el: unknown): void {
    if (!isPlainObject(el)) return;
    const target = this.model.node(rel.target);
    const source = this.model.node(rel.source);
    this.authenticate(target, "DELETE_RELATIONSHIP");
    this.authenticate(source, "DELETE_RELATIONSHIP");
    const inner = new Block();
    const t = this.ctx.variable("this");
    const r = this.ctx.variable("edge");
    const pred = and([
      this.where.connection(r, t, rel, el.where),
      this.rules.filter(t, target, "DELETE_RELATIONSHIP"),
    ]);
    const pattern = relationshipPattern(this.model, from, rel, t, r);
    // v7 matches the targets with OPTIONAL MATCH: the source is checked even when nothing matches,
    // and the target rules are then evaluated once on `null`.
    const sourceBefore = this.rules.fails(from, source, "DELETE_RELATIONSHIP", "BEFORE");
    const targetOnNull = this.onNull(t, (n) =>
      this.rules.failure([
        ...this.rules.validations(n, target, "DELETE_RELATIONSHIP", "BEFORE"),
        ...this.rules.validations(n, target, "DELETE_RELATIONSHIP", "AFTER"),
      ]),
    );
    this.capture(
      block,
      this.rules.check(
        orParts([
          sourceBefore,
          targetOnNull
            ? `(NOT EXISTS { MATCH ${pattern}${pred ? ` WHERE ${pred}` : ""} } AND ${targetOnNull})`
            : undefined,
        ]),
      ),
    );
    inner.add(`MATCH ${pattern}${pred ? ` WHERE ${pred}` : ""}`);
    this.capture(
      inner,
      this.rules.check(this.rules.fails(t, target, "DELETE_RELATIONSHIP", "BEFORE")),
    );
    if (isPlainObject(el.disconnect)) {
      for (const [name, els] of Object.entries(el.disconnect)) {
        for (const [rel2, e] of this.elements(this.relationship(target, name), els))
          this.disconnect(inner, t, rel2, e);
      }
    }
    if (inner.clauses.length > 1) inner.add("WITH *");
    inner.add(`DELETE ${r}`);
    inner.count("rd", "1");
    const targetAfter = this.rules.check(
      this.rules.fails(t, target, "DELETE_RELATIONSHIP", "AFTER"),
    );
    if (targetAfter) inner.check([targetAfter]);
    this.call(block, [from], inner);
    this.capture(
      block,
      this.rules.check(this.rules.fails(from, source, "DELETE_RELATIONSHIP", "AFTER")),
    );
  }

  /**
   * `failure(n)` evaluated with `n` bound to `null` (`[n IN [null] | …][0]`), or `undefined` when there
   * are no rules: what v7's OPTIONAL MATCH checks when no node matched.
   */
  private onNull(name: string, failure: (n: string) => string | undefined): string | undefined {
    const n = this.ctx.variable(`${name}_null`);
    const f = failure(n);
    return f === undefined ? undefined : `[${n} IN [null] | ${f}][0]`;
  }

  // ---------------------------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------------------------

  /**
   * `COLLECT { … }` lists of the nodes a `{ where, delete }` element deletes: the related nodes
   * matching `where` and, through nested `delete`, nodes related to them. `match` is the chain of
   * `MATCH … WHERE …` that binds `t`.
   */
  private deleteLists(
    match: string,
    t: string,
    node: NodeType,
    del: unknown,
    failures: string[],
  ): string[] {
    const lists = [`COLLECT { ${match} RETURN DISTINCT ${t} }`];
    if (!isPlainObject(del)) return lists;
    for (const [name, els] of Object.entries(del)) {
      for (const [rel, el] of this.elements(this.relationship(node, name), els)) {
        if (!isPlainObject(el)) continue;
        const target = this.model.node(rel.target);
        const { chain, u } = this.nestedDeleteMatch(match, t, rel, target, el, failures);
        lists.push(...this.deleteLists(chain, u, target, el.delete, failures));
      }
    }
    return lists;
  }

  /**
   * `MATCH` of a nested `{ where, delete }` from `t` (after `parent`, the chain binding `t`), with the
   * target's DELETE filter; pushes to `failures` the list of failed DELETE validations of the matched
   * nodes (v7: OPTIONAL MATCH, so the rules are also evaluated on `null` when nothing matches).
   */
  private nestedDeleteMatch(
    parent: string,
    t: string,
    rel: Relationship,
    target: NodeType,
    el: AnyRecord,
    failures: string[],
  ): { chain: string; u: string } {
    this.authenticate(target, "DELETE");
    const u = this.ctx.variable("this");
    const r = this.ctx.variable("edge");
    const pred = and([
      this.where.connection(r, u, rel, el.where),
      this.rules.filter(u, target, "DELETE"),
    ]);
    const step = `${relationshipPattern(this.model, t, rel, u, r)}${pred ? ` WHERE ${pred}` : ""}`;
    const failure = this.rules.fails(u, target, "DELETE", "BEFORE");
    if (failure) {
      failures.push(
        `COLLECT { ${parent ? `${parent} ` : ""}OPTIONAL MATCH ${step} WITH * WHERE ${failure} RETURN ${this.rules.forbiddenMessage()} }`,
      );
    }
    return { chain: `${parent ? `${parent} ` : ""}MATCH ${step}`, u };
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
    const failures: string[] = [];
    const { chain, u } = this.nestedDeleteMatch("", from, rel, target, el, failures);
    const lists = this.deleteLists(chain, u, target, el.delete, failures);
    const inner = new Block();
    const keep: string[] = [];
    if (failures.length) {
      // Evaluated before anything is deleted.
      const f = this.ctx.variable("authDelete");
      inner.add(`WITH ${failures.join(" + ")} AS ${f}`);
      inner.errors.push(f);
      keep.push(f);
    }
    this.deleteNodes(inner, `(${lists.join(" + ")})`, keep);
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
    /** Apply the READ rules to the returned nodes (update; v7 does not for create). */
    readRules: boolean,
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
        const auth = readRules ? this.select.readRules(v, node, nodesOfKey) : {};
        const scope: string[] = [];
        const proj = this.select.projectNode(v, node, nodesOfKey, scope);
        const value = auth.failure
          ? `CASE WHEN ${auth.failure} THEN ${this.select.forbiddenMap()} ELSE ${proj.expr} END`
          : proj.expr;
        const filter = auth.filter ? `\n  WITH ${v} WHERE ${auth.filter}` : "";
        const clauses = scope.map((c) => `\n${indent([c])}`).join("");
        block.add(
          `CALL (${list}) {\n  UNWIND ${list} AS ${v}${filter}${clauses}\n  RETURN collect(${value}) AS ${d}\n}`,
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
    // A failed check: the statement is rolled back and returns no data.
    const gated = block.errors.length
      ? `CASE WHEN size(info.errors) = 0 THEN ${data} ELSE {} END`
      : data;
    block.add(`RETURN { info: info, data: ${gated} } AS this`);
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
    this.authenticate(node, "CREATE");
    const block = new Block();
    const groups: string[] = [];
    const inputs = asList(args.input);
    // Inputs of types with CREATE checks are created one by one (each gets its checks).
    const checked = this.hasCreateChecks(node);
    let i = 0;
    while (i < inputs.length) {
      // Consecutive inputs without relationship fields share one `UNWIND`.
      let j = i;
      while (j < inputs.length && !checked && !this.hasRelationshipInput(node, inputs[j])) j++;
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
      false,
    );
  }

  /** Whether creating `node` has `validate` rules or field-level `@authentication` to check. */
  private hasCreateChecks(node: NodeType): boolean {
    const rules = [node.auth, ...node.attributes.map((a) => a.auth)];
    return rules.some(
      (a) =>
        a?.authorization?.validate.some((r) => r.operations.includes("CREATE")) ||
        (a !== node.auth && a?.authentication !== undefined),
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
    this.authenticate(node, "CREATE");
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
    const written = this.writtenAttributes(node, args.update);
    this.authenticate(
      node,
      "UPDATE",
      written.map((a) => a.name),
    );
    // v7 applies the type's UPDATE rules to a top-level update only when attributes are written.
    const typeRules = written.length > 0;
    const block = new Block();
    const v = this.ctx.variable("this");
    const pred = and([
      this.where.node(v, node, args.where),
      typeRules ? this.rules.filter(v, node, "UPDATE") : undefined,
    ]);
    block.add(`MATCH (${v}${labels(node.labels)})${pred ? `\nWHERE ${pred}` : ""}`);
    this.capture(block, this.updateCheck(v, node, "BEFORE", written, typeRules));
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
    const after = this.updateCheck(v, node, "AFTER", written, typeRules);
    if (after) block.check([after]);
    return this.response(block, `collect(${v})`, block.aggregate(), node, fieldNodes, true);
  }

  /** `deleteMovies(where, delete)`: one `DeleteInfo`. */
  rootDelete(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): CompiledMutation {
    this.authenticate(node, "DELETE");
    const block = new Block();
    const v = this.ctx.variable("this");
    const pred = and([this.where.node(v, node, args.where), this.rules.filter(v, node, "DELETE")]);
    block.add(`MATCH (${v}${labels(node.labels)})${pred ? `\nWHERE ${pred}` : ""}`);
    const roots = this.ctx.variable("roots");
    const nested: string[] = [];
    // Failed DELETE validations of the matched nodes, collected before anything is deleted.
    const failures: string[] = [];
    const rootFailure = this.rules.check(this.rules.fails(v, node, "DELETE", "BEFORE"));
    if (isPlainObject(args.delete)) {
      for (const [name, els] of Object.entries(args.delete)) {
        for (const [rel, el] of this.elements(this.relationship(node, name), els)) {
          if (!isPlainObject(el)) continue;
          const target = this.model.node(rel.target);
          const { chain, u } = this.nestedDeleteMatch("", v, rel, target, el, failures);
          nested.push(...this.deleteLists(chain, u, target, el.delete, failures));
        }
      }
    }
    const errorParts = [
      ...(rootFailure ? [`collect(${rootFailure})`] : []),
      ...(failures.length
        ? [`reduce(acc = [], l IN collect(${failures.join(" + ")}) | acc + l)`]
        : []),
    ];
    const keep: string[] = [];
    let errors: string | undefined;
    if (errorParts.length) {
      errors = this.ctx.variable("authErrors");
      keep.push(errors);
    }
    const errorsItem = errors ? `, ${errorParts.join(" + ")} AS ${errors}` : "";
    let list: string;
    if (nested.length) {
      const related = this.ctx.variable("related");
      block.add(
        `WITH collect(${v}) AS ${roots}, collect(${nested.join(" + ")}) AS ${related}${errorsItem}`,
      );
      list = `(${roots} + reduce(acc = [], l IN ${related} | acc + l))`;
    } else {
      block.add(`WITH collect(${v}) AS ${roots}${errorsItem}`);
      list = roots;
    }
    this.deleteNodes(block, list, keep);
    if (errors) block.errors.push(errors);
    const fields = [...collectFields(this.info, subSelections(fieldNodes))].map(
      ([k, n]) => [k, n[0]!.name.value] as const,
    );
    block.add(`RETURN ${block.aggregate(false)} AS this`);
    return {
      cypher: block.clauses.join("\n"),
      params: this.ctx.params,
      decode: (rows) => {
        const counts = (rows[0] ?? {}) as AnyRecord;
        const errors = counts.errors;
        if (Array.isArray(errors) && errors.length) throw new GraphQLError(String(errors[0]));
        return decodeCounts(fields, counts);
      },
    };
  }
}

/** The `pop` count is an Int. */
function and(parts: readonly (string | undefined)[]): string | undefined {
  const ps = parts.filter((p): p is string => p !== undefined);
  if (ps.length === 0) return undefined;
  if (ps.length === 1) return ps[0];
  return ps.map((p) => `(${p})`).join(" AND ");
}

function orParts(parts: readonly (string | undefined)[]): string | undefined {
  const ps = parts.filter((p): p is string => p !== undefined);
  if (ps.length === 0) return undefined;
  if (ps.length === 1) return ps[0];
  return ps.map((p) => `(${p})`).join(" OR ");
}

const intAttribute: Attribute = {
  name: "pop",
  property: "pop",
  type: { name: "Int", list: false, required: true, elementRequired: false },
  kind: "scalar",
  id: false,
  args: [],
};
