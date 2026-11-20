import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../components/og";

export const alt = "Cyphra: the Prisma-style ORM for Neo4j";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("neo4j-orm", {
    section: "neo4j orm",
    pattern: "(:Prisma)-[:STYLE_FOR]->(:Neo4j)",
  });
}
