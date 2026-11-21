import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "tRPC with Neo4j: end-to-end types with zod";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("guides/trpc", {
    section: "guides",
    title: "tRPC with Neo4j",
    pattern: "(:Schema)-[:GENERATES]->(:Zod)",
  });
}
