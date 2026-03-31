import type { CompiledCypher } from "@cyphra/query";

export type TraverseDirection = "OUT" | "IN" | "BOTH";

function relSegment(relType: string, maxHops: number, direction: TraverseDirection): string {
  const star = `*1..${maxHops}`;
  if (direction === "OUT") {
    return `-[r:${relType}${star}]->`;
  }
  if (direction === "IN") {
    return `<-[r:${relType}${star}]-`;
  }
  return `-[r:${relType}${star}]-`;
}

/**
 * `shortestPath` between two anchored nodes (bounded length). Fails at runtime if no path exists.
 *
 * @see https://neo4j.com/docs/cypher-manual/current/functions/path/#functions-shortestpath
 */
export function compileShortestPath(
  fromLabel: string,
  fromIdField: string,
  fromId: unknown,
  toLabel: string,
  toIdField: string,
  toId: unknown,
  relType: string,
  maxHops: number,
  direction: TraverseDirection = "BOTH",
): CompiledCypher {
  if (!Number.isInteger(maxHops) || maxHops < 1) {
    throw new Error("compileShortestPath: maxHops must be a positive integer");
  }
  const seg = relSegment(relType, maxHops, direction);
  return {
    text: `MATCH p = shortestPath((a:${fromLabel} { ${fromIdField}: $fromId })${seg}(b:${toLabel} { ${toIdField}: $toId })) RETURN p`,
    params: { fromId, toId },
  };
}

/**
 * `MATCH (a:Label { idField: $anchorId })-[:REL*1..maxHops]-(b:TargetLabel) RETURN DISTINCT b`
 * — simple multi-hop neighborhood (Phase D).
 */
export function compileRelatedNodes(
  fromLabel: string,
  idField: string,
  anchorId: unknown,
  relType: string,
  toLabel: string,
  maxHops: number,
  direction: TraverseDirection = "OUT",
): CompiledCypher {
  if (!Number.isInteger(maxHops) || maxHops < 1) {
    throw new Error("compileRelatedNodes: maxHops must be a positive integer");
  }
  const relPattern = relSegment(relType, maxHops, direction);
  return {
    text: `MATCH (a:${fromLabel} { ${idField}: $anchorId })${relPattern}(b:${toLabel}) RETURN DISTINCT b`,
    params: { anchorId },
  };
}
