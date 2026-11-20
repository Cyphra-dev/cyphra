import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../components/og";

export const alt = "Cyphra Cloud: managed Neo4j hosting";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("cloud", {
    section: "cloud",
    title: "Managed Neo4j hosting",
    pattern: "(:Neo4j)-[:RUN_BY]->(:CyphraCloud)",
  });
}
