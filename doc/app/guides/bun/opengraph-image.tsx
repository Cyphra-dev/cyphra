import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Neo4j with Bun";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("guides/bun", {
    section: "guides",
    title: "Neo4j with Bun",
    pattern: "(:Bun)-[:QUERIES]->(:Neo4j)",
  });
}
