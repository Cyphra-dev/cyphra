import type { CyphraClient } from "@cyphra/runtime";
import { compileRelatedNodes, compileShortestPath, type TraverseDirection } from "./traverse.js";

/**
 * Run {@link compileRelatedNodes} and map rows to plain records.
 */
export async function queryRelatedNodes(
  client: CyphraClient,
  args: {
    readonly fromLabel: string;
    readonly idField: string;
    readonly anchorId: unknown;
    readonly relType: string;
    readonly toLabel: string;
    readonly maxHops: number;
    readonly direction?: TraverseDirection;
  },
): Promise<Record<string, unknown>[]> {
  const compiled = compileRelatedNodes(
    args.fromLabel,
    args.idField,
    args.anchorId,
    args.relType,
    args.toLabel,
    args.maxHops,
    args.direction,
  );
  return client.withSession((session) => client.queryRecords(session, compiled));
}

/**
 * Run {@link compileShortestPath} and return the first row (or `undefined`).
 */
export async function queryShortestPath(
  client: CyphraClient,
  args: {
    readonly fromLabel: string;
    readonly fromIdField: string;
    readonly fromId: unknown;
    readonly toLabel: string;
    readonly toIdField: string;
    readonly toId: unknown;
    readonly relType: string;
    readonly maxHops: number;
    readonly direction?: TraverseDirection;
  },
): Promise<Record<string, unknown> | undefined> {
  const compiled = compileShortestPath(
    args.fromLabel,
    args.fromIdField,
    args.fromId,
    args.toLabel,
    args.toIdField,
    args.toId,
    args.relType,
    args.maxHops,
    args.direction,
  );
  return client.withSession((session) => client.queryRecord(session, compiled));
}
