import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../components/og";

export const alt = "Cyphra Cloud Terms of Service";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("terms", {
    section: "legal",
    title: "Terms of Service",
    pattern: "(:Customer)-[:AGREES_TO]->(:Terms)",
  });
}
