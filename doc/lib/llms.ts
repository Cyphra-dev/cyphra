// llms.txt (https://llmstxt.org) and llms-full.txt, built from the same sources as the site: the
// MDX docs pages, the blog and the glossary.
import { getPosts, getTerms } from "./content";
import { getDocPages, type DocPage } from "./docs";
import { SITE, absoluteUrl } from "./site";

/** URL of the plain-Markdown version of a page (served by app/md/[...slug]). */
export function markdownUrl(path: string): string {
  return absoluteUrl(`${path === "/" ? "/index" : path}.md`);
}

/** Site-relative Markdown links become absolute, so the text works outside the site. */
function absolutize(markdown: string): string {
  return markdown.replace(/\]\(\/(?!\/)/g, `](${SITE.url}/`);
}

const HEADER = `# Cyphra

> ${SITE.description}

Cyphra is a TypeScript OGM (object-graph mapper) for Neo4j (5.6+ for the typed client), what other
stacks call an ORM. You describe the graph in a
\`.cyphra\` schema; \`cyphra generate\` writes a typed client (\`findMany\`, \`include\`/\`select\`,
nested writes, \`$transaction\`, typed edge properties as \`$edge\`, raw Cypher with \`db.$cypher\`), and
\`cyphra migrate dev\` generates migrations (constraints, indexes, backfills, guards) from schema
changes. Packages: \`cyphra\` (runtime) and \`@cyphra/cli\` (dev dependency). ESM only. License: MIT.
Cyphra Cloud is managed Neo4j hosting (Neo4j Community, one instance per database).`;

function docLines(pages: DocPage[]): string[] {
  return pages.map((p) => `- [${p.title}](${markdownUrl(p.route)}): ${p.description}`);
}

export function llmsTxt(): string {
  const pages = getDocPages();
  const isComparison = (p: DocPage) =>
    p.route === "/neo4j-orm" || p.route === "/benchmarks" || p.route.startsWith("/compare");
  const under = (prefix: string) => (p: DocPage) =>
    p.route === prefix || p.route.startsWith(`${prefix}/`);
  const guides = pages.filter(under("/guides"));
  const cypher = pages.filter(under("/cypher"));
  const docs = pages.filter(
    (p) =>
      !["/", "/pricing", "/cloud"].includes(p.route) &&
      !isComparison(p) &&
      !guides.includes(p) &&
      !cypher.includes(p),
  );
  const cloud = pages.filter((p) => ["/cloud", "/pricing"].includes(p.route));
  const comparisons = pages.filter(isComparison);
  const sections = [
    HEADER,
    `## Docs\n\n${docLines(docs).join("\n")}`,
    `## Guides\n\n${docLines(guides).join("\n")}`,
    `## Cypher how-tos\n\n${docLines(cypher).join("\n")}`,
    `## Cyphra Cloud\n\n${docLines(cloud).join("\n")}`,
    `## Comparisons\n\n${docLines(comparisons).join("\n")}`,
    `## Blog\n\n${getPosts()
      .map((p) => `- [${p.title}](${markdownUrl(p.path)}): ${p.description}`)
      .join("\n")}`,
    `## Glossary\n\n${getTerms()
      .map((t) => `- [${t.title}](${markdownUrl(t.path)}): ${t.description}`)
      .join("\n")}`,
    `## Optional\n\n- [Full text of the docs, blog and glossary](${absoluteUrl("/llms-full.txt")})\n- [Source code on GitHub](https://github.com/Cyphra-dev/cyphra)\n- [cyphra on npm](https://www.npmjs.com/package/cyphra)`,
  ];
  return `${sections.join("\n\n")}\n`;
}

function section(title: string, url: string, body: string): string {
  return `---\n\nSource: ${url}\n\n${body.startsWith("# ") ? body : `# ${title}\n\n${body}`}`;
}

export function llmsFullTxt(): string {
  const parts = [HEADER];
  for (const p of getDocPages()) parts.push(section(p.title, absoluteUrl(p.route), p.markdown));
  for (const p of getPosts()) {
    parts.push(
      section(p.title, absoluteUrl(p.path), `# ${p.title}\n\n> ${p.description}\n\n${p.body}`),
    );
  }
  for (const t of getTerms()) {
    parts.push(
      section(t.title, absoluteUrl(t.path), `# ${t.title}\n\n> ${t.description}\n\n${t.body}`),
    );
  }
  return absolutize(`${parts.join("\n\n")}\n`);
}

/** Plain Markdown for one page, or undefined if the path is not a page. */
export function pageMarkdown(path: string): string | undefined {
  const body = rawPageMarkdown(path);
  return body === undefined ? undefined : absolutize(body);
}

function rawPageMarkdown(path: string): string | undefined {
  const doc = getDocPages().find((p) => p.route === path);
  if (doc) return `${doc.markdown}\n`;
  const post = getPosts().find((p) => p.path === path);
  if (post) return `# ${post.title}\n\n> ${post.description}\n\n${post.body}\n`;
  const term = getTerms().find((t) => t.path === path);
  if (term) return `# ${term.title}\n\n> ${term.description}\n\n${term.body}\n`;
  return undefined;
}

/** Every path that has a Markdown version. */
export function markdownPaths(): string[] {
  return [
    ...getDocPages().map((p) => p.route),
    ...getPosts().map((p) => p.path),
    ...getTerms().map((t) => t.path),
  ];
}
