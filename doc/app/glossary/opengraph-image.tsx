import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "../../components/og";

export const alt = "Cyphra graph database glossary";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOgImage({
    section: "glossary",
    title: "Graph database glossary",
    description: "Short, exact definitions of the Neo4j terms you meet every day.",
    pattern: "(:Glossary)-[:DEFINES]->(:Term)",
  });
}
