import nextra from "nextra";
import { bundledLanguages, createHighlighter } from "shiki";
import { cyphraDark, cyphraLanguage, cyphraLight } from "./lib/shiki.mjs";

// One highlighter for every MDX file: loading all grammars per file makes builds very slow.
let highlighter;

const withNextra = nextra({
  search: true,
  mdxOptions: {
    rehypePrettyCodeOptions: {
      // Brand code themes, plus the `cyphra` schema language for ```cyphra fences.
      theme: { light: cyphraLight, dark: cyphraDark },
      getHighlighter: (opts) =>
        (highlighter ??= createHighlighter({
          ...opts,
          langs: [...Object.keys(bundledLanguages).filter((l) => l !== "mermaid"), cyphraLanguage],
        })),
    },
  },
});

export default withNextra({
  reactStrictMode: true,
  // One URL per page: "/glossary/" answers 308 → "/glossary", matching the canonical and the
  // sitemap. This is Next's default; it is spelled out because the SEO audit relies on it.
  trailingSlash: false,
  eslint: { ignoreDuringBuilds: true },
  // `<page>.md` serves the plain-Markdown version of a page (app/md/[...slug]/route.ts).
  async rewrites() {
    return [
      { source: "/:a([a-z0-9-]+)\\.md", destination: "/md/:a" },
      { source: "/:a([a-z0-9-]+)/:b([a-z0-9-]+)\\.md", destination: "/md/:a/:b" },
    ];
  },
});
