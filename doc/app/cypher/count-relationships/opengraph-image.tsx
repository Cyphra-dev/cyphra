import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Count relationships";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("cypher/count-relationships", {
    section: "cypher",
    title: "Count relationships",
    pattern: "COUNT { (u)-[:AUTHORED]->() }",
  });
}
