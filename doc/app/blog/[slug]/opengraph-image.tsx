import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "../../../components/og";
import { getPost, getPosts } from "../../../lib/content";

export const alt = "Cyphra blog post";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  return getPosts().map((p) => ({ slug: p.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const post = getPost((await params).slug);
  return renderOgImage({
    section: "blog",
    title: post?.title ?? "Cyphra blog",
    description: post?.description,
    pattern: `(:Blog)-[:PUBLISHED {on: "${post?.date ?? ""}"}]->(:Post)`,
  });
}
