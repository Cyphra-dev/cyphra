import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../components/og";

export const alt = "Neo4j ORM? Cyphra is an OGM (object-graph mapper) for TypeScript";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("neo4j-orm", {
    section: "neo4j orm",
    title: "Neo4j ORM? Cyphra is an OGM",
    pattern: "(:Node)-[:RELATIONSHIP {since}]->(:Node)",
  });
}
