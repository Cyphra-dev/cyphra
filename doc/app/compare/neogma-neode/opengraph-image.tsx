import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Cyphra vs neogma and neode";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("compare/neogma-neode", {
    section: "compare",
    pattern: "(:Cyphra)-[:VS]->(:Neogma), (:Neode)",
  });
}
