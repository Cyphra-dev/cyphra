/**
 * Typed path results (`{ nodes, edges }`), shared by traversals and shortest-path queries.
 *
 * A path is never returned as a driver `Path` value: the statement turns it into a plain map of
 * lists, strings and booleans ({@link compilePath}), so decoding needs no `instanceof` check on a
 * driver class and works the same with `neo4j-driver` 5 and 6, from any copy of the package.
 *
 * @packageDocumentation
 */

import type { ResolvedNodeModel, ResolvedScalarField, SchemaModel } from "@cyphra/schema";
import type { QueryContext } from "./compile.js";
import { decodeScalar, toNative } from "./values.js";
import type { Path, PathEdge } from "./types.js";

type AnyRecord = Record<string, unknown>;

/**
 * Cypher expression for path variable `path` as
 * `{nodes: [{labels, properties}], edges: [{type, properties, out}]}`, where `out` is `true` when
 * `edges[i]` points from `nodes[i]` to `nodes[i + 1]`. Decode it with {@link decodePath}.
 */
export function compilePath(ctx: QueryContext, path: string): string {
  const x = ctx.variable("x");
  const i = ctx.variable("i");
  const rel = `relationships(${path})[${i}]`;
  const nodes = `[${x} IN nodes(${path}) | {labels: labels(${x}), properties: properties(${x})}]`;
  const edges =
    `[${i} IN range(0, length(${path}) - 1) | ` +
    `{type: type(${rel}), properties: properties(${rel}), out: startNode(${rel}) = nodes(${path})[${i}]}]`;
  return `{nodes: ${nodes}, edges: ${edges}}`;
}

function decodeProps(fields: readonly ResolvedScalarField[], raw: unknown): AnyRecord {
  const src = (raw ?? {}) as AnyRecord;
  const out: AnyRecord = {};
  for (const f of fields) out[f.name] = decodeScalar(f, src[f.name]);
  return out;
}

function scalarsOf(model: ResolvedNodeModel): ResolvedScalarField[] {
  return model.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
}

/**
 * Decode a value built by {@link compilePath}. Nodes are decoded with the scalar fields of the
 * model whose label they carry, edges with the `relationship { … }` model of their type and
 * endpoints (`{}` for an untyped edge). Properties outside the schema are dropped; a node with no
 * known label keeps its raw properties (converted with {@link toNative}).
 */
export function decodePath(schema: SchemaModel, raw: unknown): Path<AnyRecord, PathEdge> {
  const src = (raw ?? {}) as { nodes?: unknown[]; edges?: unknown[] };
  const rawNodes = (src.nodes ?? []) as { labels?: unknown[]; properties?: unknown }[];
  const models = rawNodes.map((n) => schema.nodes.find((m) => (n.labels ?? []).includes(m.label)));
  const nodes = rawNodes.map((n, i) => {
    const model = models[i];
    return model
      ? decodeProps(scalarsOf(model), n.properties)
      : (toNative(n.properties ?? {}) as AnyRecord);
  });
  const rawEdges = (src.edges ?? []) as { type?: unknown; properties?: unknown; out?: unknown }[];
  const edges = rawEdges.map((e, i): PathEdge => {
    const type = String(e.type);
    const out = e.out === true;
    const start = models[out ? i : i + 1]?.name;
    const end = models[out ? i + 1 : i]?.name;
    const candidates = schema.relationships.filter((r) => r.relType === type);
    const edgeModel =
      candidates.find((r) => r.from === start && r.to === end) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    return {
      type,
      direction: out ? "out" : "in",
      properties: edgeModel ? decodeProps(edgeModel.properties, e.properties) : {},
    };
  });
  return { nodes, edges };
}
