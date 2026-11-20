import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "MERGE vs CREATE";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("cypher/merge-vs-create", {
    section: "cypher",
    title: "MERGE vs CREATE",
    pattern: "(:Merge)-[:VS]->(:Create)",
  });
}
