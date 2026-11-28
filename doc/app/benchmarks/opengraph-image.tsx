import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../components/og";

export const alt = "Cyphra benchmarks: the cost of the OGM layer over the raw Neo4j driver";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("benchmarks", {
    section: "benchmarks",
    pattern: "(:Cyphra)-[:MEASURED_AGAINST]->(:Neo4jDriver)",
  });
}
