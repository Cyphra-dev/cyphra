import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Cyphra vs the Neo4j GraphQL Library";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("compare/neo4j-graphql-library", {
    section: "compare",
    pattern: "(:Cyphra)-[:VS]->(:Neo4jGraphQL)",
  });
}
