import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Create a relationship";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("cypher/create-relationship", {
    section: "cypher",
    title: "Create a relationship",
    pattern: "(a:User)-[:FOLLOWS]->(b:User)",
  });
}
