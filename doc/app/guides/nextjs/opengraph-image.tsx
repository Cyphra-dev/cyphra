import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Neo4j with Next.js";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("guides/nextjs", {
    section: "guides",
    title: "Neo4j with Next.js",
    pattern: "(:NextJs)-[:QUERIES]->(:Neo4j)",
  });
}
