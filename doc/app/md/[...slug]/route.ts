// Plain-Markdown version of every docs page, blog post and glossary term, for LLMs and tools.
// Public URLs are `<page>.md` (e.g. /schema.md, /blog/<slug>.md, /index.md for the home page);
// next.config.mjs rewrites them here. Not indexed: the HTML page is the canonical version.
import { notFound } from "next/navigation";
import { markdownPaths, pageMarkdown } from "../../../lib/llms";
import { absoluteUrl } from "../../../lib/site";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return markdownPaths().map((path) => ({
    slug: path === "/" ? ["index"] : path.slice(1).split("/"),
  }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const path = slug.join("/") === "index" ? "/" : `/${slug.join("/")}`;
  const body = pageMarkdown(path);
  if (!body) notFound();
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Robots-Tag": "noindex",
      Link: `<${absoluteUrl(path)}>; rel="canonical"`,
    },
  });
}
