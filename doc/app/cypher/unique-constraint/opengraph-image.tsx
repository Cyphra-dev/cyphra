import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Unique constraints in Neo4j";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("cypher/unique-constraint", {
    section: "cypher",
    title: "Unique constraints in Neo4j",
    pattern: "REQUIRE u.email IS UNIQUE",
  });
}
