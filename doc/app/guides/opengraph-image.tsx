import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../components/og";

export const alt = "Neo4j framework guides";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("guides", {
    section: "guides",
    title: "Neo4j framework guides",
    pattern: "(:Guide)-[:FOR]->(:Framework)",
  });
}
