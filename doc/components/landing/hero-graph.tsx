// The hero's property graph: a small social/blog graph drawn as a schematic (1px edges, small
// circle nodes, mono labels, signal arrowheads). Everything is static SVG animated with CSS on the
// same cycle as the hero editor (--cycle in landing.module.css): when the editor's query runs, the
// edges it matches, (:User)-[:AUTHORED]->(:Post), light up and a pulse travels along them.

import type { CSSProperties } from "react";
import styles from "./landing.module.css";

type Node = {
  id: string;
  label: string;
  type: string;
  x: number;
  y: number;
  /** Label placement relative to the node. */
  side?: "right" | "left" | "top" | "bottom";
  hot?: boolean;
};

type Edge = { from: string; to: string; type: string; hot?: boolean; ambient?: number };

type GraphData = { viewBox: string; nodes: Node[]; edges: Edge[] };

export const DESKTOP_GRAPH: GraphData = {
  viewBox: "0 0 640 400",
  nodes: [
    { id: "acme", label: "acme", type: "Company", x: 92, y: 74, side: "right" },
    { id: "alice", label: "alice", type: "User", x: 196, y: 196, side: "bottom", hot: true },
    { id: "bob", label: "bob", type: "User", x: 74, y: 326, side: "right", hot: true },
    { id: "carol", label: "carol", type: "User", x: 330, y: 334, side: "bottom", hot: true },
    { id: "p1", label: "p1", type: "Post", x: 386, y: 104, side: "top", hot: true },
    { id: "p2", label: "p2", type: "Post", x: 442, y: 226, side: "right", hot: true },
    { id: "p3", label: "p3", type: "Post", x: 540, y: 330, side: "bottom", hot: true },
    { id: "neo4j", label: "neo4j", type: "Tag", x: 560, y: 64, side: "bottom" },
    { id: "ts", label: "typescript", type: "Tag", x: 590, y: 186, side: "top" },
  ],
  edges: [
    { from: "alice", to: "acme", type: "WORKS_AT", ambient: 0 },
    { from: "bob", to: "acme", type: "WORKS_AT" },
    { from: "bob", to: "alice", type: "FOLLOWS", ambient: 1 },
    { from: "bob", to: "carol", type: "FOLLOWS" },
    { from: "alice", to: "p1", type: "AUTHORED", hot: true },
    { from: "alice", to: "p2", type: "AUTHORED", hot: true },
    { from: "carol", to: "p3", type: "AUTHORED", hot: true },
    { from: "p1", to: "neo4j", type: "TAGGED", ambient: 2 },
    { from: "p2", to: "ts", type: "TAGGED" },
    { from: "p3", to: "ts", type: "TAGGED", ambient: 3 },
  ],
};

export const MOBILE_GRAPH: GraphData = {
  viewBox: "0 0 340 236",
  nodes: [
    { id: "acme", label: "acme", type: "Company", x: 46, y: 46, side: "right" },
    { id: "alice", label: "alice", type: "User", x: 132, y: 136, side: "bottom", hot: true },
    { id: "bob", label: "bob", type: "User", x: 40, y: 200, side: "right", hot: true },
    { id: "p1", label: "p1", type: "Post", x: 288, y: 52, side: "bottom", hot: true },
    { id: "p2", label: "p2", type: "Post", x: 292, y: 184, side: "bottom", hot: true },
  ],
  edges: [
    { from: "alice", to: "acme", type: "WORKS_AT", ambient: 0 },
    { from: "bob", to: "alice", type: "FOLLOWS", ambient: 1 },
    { from: "alice", to: "p1", type: "AUTHORED", hot: true },
    { from: "alice", to: "p2", type: "AUTHORED", hot: true },
  ],
};

const R = 6;

function labelPos(n: Node) {
  switch (n.side) {
    case "left":
      return { x: n.x - 12, y: n.y + 4, anchor: "end" as const };
    case "top":
      return { x: n.x, y: n.y - 13, anchor: "middle" as const };
    case "bottom":
      return { x: n.x, y: n.y + 22, anchor: "middle" as const };
    default:
      return { x: n.x + 12, y: n.y + 4, anchor: "start" as const };
  }
}

export function PropertyGraph({ data, className }: { data: GraphData; className?: string }) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  return (
    <svg
      className={`${styles.pg} ${className ?? ""}`}
      viewBox={data.viewBox}
      role="img"
      aria-label="Property graph: users who work at a company, follow each other and author posts tagged with topics. The query matches (:User)-[:AUTHORED]->(:Post)."
    >
      {data.edges.map((e, i) => {
        const a = byId.get(e.from)!;
        const b = byId.get(e.to)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        const ux = dx / len;
        const uy = dy / len;
        // Start at the source node's edge; stop short of the target for the arrowhead.
        const x1 = a.x + ux * (R + 2);
        const y1 = a.y + uy * (R + 2);
        const x2 = b.x - ux * (R + 4);
        const y2 = b.y - uy * (R + 4);
        const d = `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
        // Arrowhead: a 7px chevron at the target end.
        const hx = x2;
        const hy = y2;
        const px = -uy;
        const py = ux;
        const head = `M${(hx - ux * 7 + px * 4).toFixed(1)} ${(hy - uy * 7 + py * 4).toFixed(1)}L${hx.toFixed(1)} ${hy.toFixed(1)}L${(hx - ux * 7 - px * 4).toFixed(1)} ${(hy - uy * 7 - py * 4).toFixed(1)}`;
        // Relationship type along the edge, kept upright.
        let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const cls = [
          styles.pgEdge,
          e.hot ? styles.pgHot : "",
          e.ambient !== undefined ? styles.pgAmbient : "",
        ].join(" ");
        return (
          <g
            key={`${e.from}-${e.to}`}
            className={cls}
            style={
              {
                "--d": `${i * 70}ms`,
                "--a": `${(e.ambient ?? 0) * 0.9}s`,
              } as CSSProperties
            }
          >
            <path d={d} className={styles.pgLine} pathLength={1} />
            <path d={head} className={styles.pgHead} />
            <path d={d} className={styles.pgPulse} pathLength={1} />
            <text
              className={styles.pgRel}
              x={mx}
              y={my}
              dy={-5}
              textAnchor="middle"
              transform={`rotate(${angle.toFixed(1)} ${mx} ${my})`}
            >
              {e.type}
            </text>
          </g>
        );
      })}
      {data.nodes.map((n, i) => {
        const l = labelPos(n);
        return (
          <g
            key={n.id}
            className={`${styles.pgNode} ${n.hot ? styles.pgNodeHot : ""} ${
              n.type === "User" ? styles.pgUser : ""
            }`}
            style={{ "--d": `${200 + i * 60}ms` } as CSSProperties}
          >
            <circle className={styles.pgRing} cx={n.x} cy={n.y} r={R + 5} />
            <circle className={styles.pgDot} cx={n.x} cy={n.y} r={R} />
            <text className={styles.pgLabel} x={l.x} y={l.y} textAnchor={l.anchor}>
              {n.label}
              <tspan className={styles.pgType}>:{n.type}</tspan>
            </text>
          </g>
        );
      })}
    </svg>
  );
}
