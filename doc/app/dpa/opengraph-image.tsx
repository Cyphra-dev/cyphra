import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../components/og";

export const alt = "Cyphra Cloud Data Processing Agreement";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("dpa", {
    section: "legal",
    title: "Data Processing Agreement",
    pattern: "(:FAKGROUP)-[:PROCESSES_FOR]->(:Customer)",
  });
}
