import type { MetadataRoute } from "next";
import { getPosts, getTerms } from "../lib/content";
import { getDocPages } from "../lib/docs";
import { absoluteUrl } from "../lib/site";

// Docs pages are every app/**/page.mdx (walked at build time, so new pages land here without
// editing this file); blog posts and glossary terms come from content/.
export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getPosts();
  const terms = getTerms();
  // No lastModified on docs pages: file mtimes on Vercel are the checkout time, not edits.
  const docs: MetadataRoute.Sitemap = getDocPages().map((p) => ({
    url: absoluteUrl(p.route),
    changeFrequency: "weekly",
    priority: p.route === "/" ? 1 : 0.7,
  }));
  const latest = posts[0]?.updated ?? posts[0]?.date;
  return [
    ...docs,
    {
      url: absoluteUrl("/blog"),
      ...(latest ? { lastModified: latest } : {}),
      changeFrequency: "weekly",
      priority: 0.6,
    },
    ...posts.map((p) => ({
      url: absoluteUrl(p.path),
      lastModified: p.updated ?? p.date,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    { url: absoluteUrl("/glossary"), changeFrequency: "monthly", priority: 0.5 },
    ...terms.map((t) => ({
      url: absoluteUrl(t.path),
      lastModified: t.updated ?? t.date,
      changeFrequency: "monthly" as const,
      priority: 0.5,
    })),
  ];
}
