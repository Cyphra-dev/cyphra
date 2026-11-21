import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "GraphRAG with Neo4j and TypeScript";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("guides/graphrag", {
    section: "guides",
    title: "GraphRAG with Neo4j",
    pattern: "(:Chunk)-[:MENTIONS]->(:Entity)",
  });
}
