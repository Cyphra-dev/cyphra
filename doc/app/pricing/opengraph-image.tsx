import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../components/og";

export const alt = "Cyphra Cloud pricing";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("pricing", {
    section: "pricing",
    title: "Managed Neo4j, priced per database",
    pattern: "(:Database)-[:ON]->(:Plan {from: 0})",
  });
}
