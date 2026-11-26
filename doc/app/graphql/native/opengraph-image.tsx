import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Native GraphQL API for Neo4j";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("graphql/native", {
    section: "graphql",
    title: "Native GraphQL API",
    pattern: "(:Schema)-[:GENERATES]->(:GraphQL)",
  });
}
