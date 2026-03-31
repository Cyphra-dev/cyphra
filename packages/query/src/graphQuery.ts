import type { OrderDirection, WherePredicate } from "./builder.js";
import { eq, node, prop, rel, select } from "./builder.js";
import type { CompiledCypher } from "./cypher.js";
import { compileMapProjection } from "./mapProjection.js";
import { concatCompiledCypher } from "./compose.js";
import { compileCreate, compileCreateRelationship } from "./write.js";

function assertIdent(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label}: invalid identifier ${JSON.stringify(name)}`);
  }
}

/**
 * Map projection for a RETURN column: **JavaScript** `pick` list → Cypher **`variable { .a, .b }`**.
 *
 * @see {@link compileMapProjection}
 */
export type JsMapProjection = {
  /** Column name in the result row (`RETURN … AS resultKey`). */
  readonly resultKey: string;
  /** Bound variable (e.g. **`p`**). */
  readonly variable: string;
  /** Property names on that variable. */
  readonly pick: readonly string[];
};

/**
 * Scalar property from another variable (e.g. author name → **`a.name`**).
 */
export type JsScalarRef = {
  readonly variable: string;
  readonly property: string;
};

/**
 * Build **`returnRawFields`** input from structured maps + scalars (no hand-written Cypher snippets for maps).
 */
export function buildReturnRawFieldsMap(options: {
  readonly maps: readonly JsMapProjection[];
  readonly scalars?: Readonly<Record<string, JsScalarRef>>;
}): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const m of options.maps) {
    assertIdent(m.resultKey, "buildReturnRawFieldsMap(maps.resultKey)");
    fields[m.resultKey] = compileMapProjection(m.variable, [...m.pick]);
  }
  if (options.scalars) {
    for (const [key, ref] of Object.entries(options.scalars)) {
      assertIdent(key, "buildReturnRawFieldsMap(scalars key)");
      assertIdent(ref.variable, "buildReturnRawFieldsMap(scalars.variable)");
      assertIdent(ref.property, "buildReturnRawFieldsMap(scalars.property)");
      fields[key] = `${ref.variable}.${ref.property}`;
    }
  }
  return fields;
}

/** Optional **`OUT`** relationship from root to one target node (for `OPTIONAL MATCH`). */
export type OutgoingRelSpec = {
  readonly relType: string;
  readonly relAlias: string;
  readonly targetLabel: string;
  readonly targetAlias: string;
};

/**
 * **`MATCH (root)`** + optional **`OPTIONAL MATCH (root)-[rel:TYPE]->(target)`**, structured return maps/scalars,
 * optional **`WHERE`**, **`ORDER BY`**, **`LIMIT`** — composed without pasting Cypher pattern strings for the common case.
 */
export function compileRootOptionalOutgoingSelect(spec: {
  readonly rootLabel: string;
  readonly rootAlias: string;
  readonly outgoing?: OutgoingRelSpec;
  readonly returnMaps: readonly JsMapProjection[];
  readonly scalars?: Readonly<Record<string, JsScalarRef>>;
  readonly where?: readonly WherePredicate[];
  readonly orderBy?: {
    readonly variable: string;
    readonly property: string;
    readonly direction: OrderDirection;
  };
  readonly skip?: number;
  readonly limit?: number;
}): CompiledCypher {
  assertIdent(spec.rootAlias, "compileRootOptionalOutgoingSelect(rootAlias)");
  assertIdent(spec.rootLabel, "compileRootOptionalOutgoingSelect(rootLabel)");

  let q = select().match(`(${spec.rootAlias}:${spec.rootLabel})`);

  if (spec.outgoing) {
    assertIdent(spec.outgoing.relType, "compileRootOptionalOutgoingSelect(outgoing.relType)");
    assertIdent(spec.outgoing.relAlias, "compileRootOptionalOutgoingSelect(outgoing.relAlias)");
    assertIdent(
      spec.outgoing.targetLabel,
      "compileRootOptionalOutgoingSelect(outgoing.targetLabel)",
    );
    assertIdent(
      spec.outgoing.targetAlias,
      "compileRootOptionalOutgoingSelect(outgoing.targetAlias)",
    );
    const p = node(spec.rootLabel, spec.rootAlias);
    const r = rel(spec.outgoing.relType, spec.outgoing.relAlias);
    const t = node(spec.outgoing.targetLabel, spec.outgoing.targetAlias);
    q = q.optionalMatch(p.out(r, t));
  }

  if (spec.where !== undefined && spec.where.length > 0) {
    q = q.where(...spec.where);
  }

  q = q.returnRawFields(buildReturnRawFieldsMap({ maps: spec.returnMaps, scalars: spec.scalars }));

  if (spec.orderBy !== undefined) {
    assertIdent(spec.orderBy.variable, "compileRootOptionalOutgoingSelect(orderBy.variable)");
    assertIdent(spec.orderBy.property, "compileRootOptionalOutgoingSelect(orderBy.property)");
    q = q.orderBy({
      expression: `${spec.orderBy.variable}.${spec.orderBy.property}`,
      direction: spec.orderBy.direction,
    });
  }

  if (spec.skip !== undefined) {
    q = q.skip(spec.skip);
  }

  if (spec.limit !== undefined) {
    q = q.limit(spec.limit);
  }

  return q.toCypher();
}

/**
 * Same graph shape as {@link compileRootOptionalOutgoingSelect} with **defaults** for the usual case:
 * - Root alias **`n`**, rel **`r`**, target **`a`**
 * - Return columns **`root`** and **`included`** (aligns with ORM `findMany` / `findFirst` row shape)
 * - Optional **`whereRootEq`**: AND of `n.prop = value` without hand-writing {@link eq} / {@link prop}
 */
export function compileRootWithOptionalOut(spec: {
  readonly root: {
    readonly label: string;
    readonly pick: readonly string[];
    readonly alias?: string;
  };
  readonly optionalRelationship?: {
    readonly type: string;
    readonly targetLabel: string;
    readonly pick: readonly string[];
    readonly relAlias?: string;
    readonly targetAlias?: string;
  };
  readonly where?: readonly WherePredicate[];
  /** Each entry becomes `eq(prop(rootAlias, key), value)` AND-combined. */
  readonly whereRootEq?: Readonly<Record<string, unknown>>;
  readonly orderBy?: { readonly on: string; readonly direction: OrderDirection };
  readonly skip?: number;
  readonly limit?: number;
}): CompiledCypher {
  const rootAlias = spec.root.alias ?? "n";
  const preds: WherePredicate[] = [];
  if (spec.whereRootEq) {
    for (const [k, v] of Object.entries(spec.whereRootEq)) {
      preds.push(eq(prop(rootAlias, k), v));
    }
  }
  if (spec.where !== undefined && spec.where.length > 0) {
    preds.push(...spec.where);
  }

  const outgoing = spec.optionalRelationship;
  const returnMaps: JsMapProjection[] = [
    { resultKey: "root", variable: rootAlias, pick: spec.root.pick },
  ];
  if (outgoing !== undefined) {
    const targetAlias = outgoing.targetAlias ?? "a";
    returnMaps.push({
      resultKey: "included",
      variable: targetAlias,
      pick: outgoing.pick,
    });
  }

  return compileRootOptionalOutgoingSelect({
    rootLabel: spec.root.label,
    rootAlias,
    outgoing:
      outgoing !== undefined
        ? {
            relType: outgoing.type,
            relAlias: outgoing.relAlias ?? "r",
            targetLabel: outgoing.targetLabel,
            targetAlias: outgoing.targetAlias ?? "a",
          }
        : undefined,
    returnMaps,
    where: preds.length > 0 ? preds : undefined,
    orderBy:
      spec.orderBy !== undefined
        ? {
            variable: rootAlias,
            property: spec.orderBy.on,
            direction: spec.orderBy.direction,
          }
        : undefined,
    skip: spec.skip,
    limit: spec.limit,
  });
}

function applyCreateServerTimestamp(
  compiled: CompiledCypher,
  alias: string,
  property: string,
): CompiledCypher {
  assertIdent(alias, "applyCreateServerTimestamp(alias)");
  assertIdent(property, "applyCreateServerTimestamp(property)");
  const needle = `SET ${alias} += $props`;
  if (!compiled.text.includes(needle)) {
    throw new Error(`graphQuery: expected CREATE text to contain ${JSON.stringify(needle)}`);
  }
  return {
    text: compiled.text.replace(needle, `${needle}, ${alias}.${property} = datetime()`),
    params: compiled.params,
  };
}

/**
 * Create one **primary** node, optionally a **secondary** node and a **relationship** primary→secondary in one query
 * (same shape as multi-`CREATE` in Neo4j).
 *
 * - **`serverTimestamp`** on primary appends **`, alias.prop = datetime()`** after **`SET … += $props`**.
 */
export type CreateLinkedNodesSpec = {
  readonly primary: {
    readonly label: string;
    readonly alias: string;
    readonly props: Record<string, unknown>;
    /** Property name to set with **`datetime()`** server-side (e.g. **`createdAt`**). */
    readonly serverTimestamp?: string;
  };
  readonly secondary?: {
    readonly label: string;
    readonly alias: string;
    readonly props: Record<string, unknown>;
  };
  /** Required when **`secondary`** is set. */
  readonly link?: {
    readonly type: string;
    readonly alias: string;
  };
};

export function compileCreateLinkedNodes(spec: CreateLinkedNodesSpec): CompiledCypher {
  const { primary, secondary, link } = spec;
  assertIdent(primary.label, "compileCreateLinkedNodes(primary.label)");
  assertIdent(primary.alias, "compileCreateLinkedNodes(primary.alias)");

  if (secondary !== undefined) {
    if (link === undefined) {
      throw new Error("compileCreateLinkedNodes: link is required when secondary is set");
    }
    assertIdent(secondary.label, "compileCreateLinkedNodes(secondary.label)");
    assertIdent(secondary.alias, "compileCreateLinkedNodes(secondary.alias)");
    assertIdent(link.type, "compileCreateLinkedNodes(link.type)");
    assertIdent(link.alias, "compileCreateLinkedNodes(link.alias)");

    let primaryPart = compileCreate(primary.label, primary.props, primary.alias);
    if (primary.serverTimestamp !== undefined) {
      primaryPart = applyCreateServerTimestamp(primaryPart, primary.alias, primary.serverTimestamp);
    }

    return concatCompiledCypher(
      [
        primaryPart,
        compileCreate(secondary.label, secondary.props, secondary.alias),
        compileCreateRelationship(primary.alias, link.alias, link.type, secondary.alias),
      ],
      { separator: " " },
    );
  }

  let single = compileCreate(primary.label, primary.props, primary.alias);
  if (primary.serverTimestamp !== undefined) {
    single = applyCreateServerTimestamp(single, primary.alias, primary.serverTimestamp);
  }
  return single;
}
