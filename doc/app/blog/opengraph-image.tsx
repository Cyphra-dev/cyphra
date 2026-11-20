import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "../../components/og";

export const alt = "Cyphra blog";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOgImage({
    section: "blog",
    title: "Notes on typed graphs",
    description: "Neo4j, Cypher and TypeScript in practice, from the team building Cyphra.",
    pattern: "(:Blog)-[:PUBLISHES]->(:Post)",
  });
}
