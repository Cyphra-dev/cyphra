import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../components/og";

export const alt = "Cyphra compared with other Neo4j libraries";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("compare", {
    section: "compare",
    pattern: "(:Cyphra)-[:COMPARED_TO]->(:Alternatives)",
  });
}
