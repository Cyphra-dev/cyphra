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
  eslint: { ignoreDuringBuilds: true },
});
