import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "../components/og";

export const alt = "Cyphra: the typed OGM for Neo4j";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOgImage({
    title: "The typed OGM for Neo4j",
    description:
      "One schema file. A fully typed TypeScript client, nested writes and migrations from schema diffs.",
    pattern: "(:Schema)-[:GENERATES]->(:TypedClient)",
  });
}
