import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Parameters and Cypher injection";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("cypher/parameters", {
    section: "cypher",
    title: "Parameters and Cypher injection",
    pattern: "WHERE u.name = $name",
  });
}
