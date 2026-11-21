import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Migrate from @neo4j/graphql to Cyphra";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("guides/migrate-from-neo4j-graphql", {
    section: "guides",
    title: "Migrate from @neo4j/graphql",
    pattern: "(:TypeDefs)-[:SERVED_BY]->(:Cyphra)",
  });
}
