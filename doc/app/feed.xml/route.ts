// RSS 2.0 feed of the blog, generated at build time. Linked from every page via
// <link rel="alternate" type="application/rss+xml"> (see app/layout.tsx).
import { getPosts } from "../../lib/content";
import { SITE, absoluteUrl } from "../../lib/site";

export const dynamic = "force-static";

function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const rfc822 = (iso: string) => new Date(`${iso}T00:00:00Z`).toUTCString();

export function GET() {
  const posts = getPosts();
  const items = posts
    .map((p) =>
      [
        "    <item>",
        `      <title>${xml(p.title)}</title>`,
        `      <link>${absoluteUrl(p.path)}</link>`,
        `      <guid isPermaLink="true">${absoluteUrl(p.path)}</guid>`,
        `      <description>${xml(p.description)}</description>`,
        `      <pubDate>${rfc822(p.date)}</pubDate>`,
        `      <dc:creator>${xml(p.author)}</dc:creator>`,
        ...p.tags.map((t) => `      <category>${xml(t)}</category>`),
        "    </item>",
      ].join("\n"),
    )
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Cyphra blog</title>
    <link>${absoluteUrl("/blog")}</link>
    <description>${xml("Neo4j, Cypher and TypeScript in practice, from the team building Cyphra.")}</description>
    <language>${SITE.language}</language>
    <atom:link href="${absoluteUrl("/feed.xml")}" rel="self" type="application/rss+xml" />
    <image>
      <url>${SITE.logo}</url>
      <title>Cyphra blog</title>
      <link>${absoluteUrl("/blog")}</link>
    </image>
${posts[0] ? `    <lastBuildDate>${rfc822(posts[0].updated ?? posts[0].date)}</lastBuildDate>\n` : ""}${items}
  </channel>
</rss>
`;
  return new Response(body, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
