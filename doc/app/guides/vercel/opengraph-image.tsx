import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Deploy a Neo4j app on Vercel";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("guides/vercel", {
    section: "guides",
    title: "Deploy a Neo4j app on Vercel",
    pattern: "(:Vercel)-[:DEPLOYS]->(:App)",
  });
}
