import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../components/og";

export const alt = "Cypher how-tos";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("cypher", {
    section: "cypher",
    title: "Cypher how-tos",
    pattern: "(:Question)-[:ANSWERED_BY]->(:Cypher)",
  });
}
