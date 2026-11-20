import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "../../../components/og";
import { getTerm, getTerms } from "../../../lib/content";

export const alt = "Cyphra glossary term";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  return getTerms().map((t) => ({ slug: t.slug }));
}

const label = (title: string) =>
  title
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const term = getTerm((await params).slug);
  const title = term?.title ?? "Glossary";
  return renderOgImage({
    section: "glossary",
    title,
    description: term?.description,
    pattern: `(:Glossary)-[:DEFINES]->(:${label(title)})`,
  });
}
