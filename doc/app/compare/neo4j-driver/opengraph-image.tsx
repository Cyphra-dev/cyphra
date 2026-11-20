import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Cyphra vs the Neo4j JavaScript driver";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("compare/neo4j-driver", {
    section: "compare",
    pattern: "(:Cyphra)-[:WRAPS]->(:Neo4jDriver)",
  });
}
