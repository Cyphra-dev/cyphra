import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "../components/og";

export const alt = "Cyphra: the typed ORM for Neo4j";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOgImage({
    eyebrow: "Open source · Neo4j + TypeScript",
    title: "The typed ORM for Neo4j.",
    description:
      "A fully typed TypeScript client, nested writes and schema-diff migrations, from one schema file.",
  });
}
