import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Neo4j pagination";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("cypher/pagination", {
    section: "cypher",
    title: "Neo4j pagination",
    pattern: "ORDER BY p.createdAt DESC LIMIT $n",
  });
}
