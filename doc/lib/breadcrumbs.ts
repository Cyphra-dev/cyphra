// Breadcrumb trails for BreadcrumbList JSON-LD, derived from the file a page comes from and the
// sidebar titles in app/_meta.ts.
import type { Crumb } from "../components/seo/structured-data";
import { getDocPage } from "./docs";

const HOME: Crumb = { name: "Cyphra", path: "/" };
const DOCS: Crumb = { name: "Docs", path: "/getting-started" };
const BLOG: Crumb = { name: "Blog", path: "/blog" };
const GLOSSARY: Crumb = { name: "Glossary", path: "/glossary" };
const COMPARE: Crumb = { name: "Compare", path: "/compare" };

// Sections with their own index page: a page under them gets Home > Section > Page.
const SECTIONS: Record<string, Crumb> = {
  guides: { name: "Guides", path: "/guides" },
  cypher: { name: "Cypher how-tos", path: "/cypher" },
};

// Docs pages that sit at the top level of the navbar rather than under "Docs".
const TOP_LEVEL = new Set([
  "/getting-started",
  "/pricing",
  "/cloud",
  "/neo4j-orm",
  "/benchmarks",
  "/terms",
  "/privacy",
  "/dpa",
]);

/**
 * `filePath` is the page's source file as Nextra reports it ("app/schema/page.mdx",
 * "content/blog/<slug>.md", "app/blog/page.tsx"). Returns null for the home page.
 */
export function crumbsFor(filePath: string, title?: string): Crumb[] | null {
  const content = /^content\/(blog|glossary)\/([^/]+)\.mdx?$/.exec(filePath);
  if (content) {
    const [, collection, slug] = content;
    const parent = collection === "blog" ? BLOG : GLOSSARY;
    return [HOME, parent, { name: title ?? slug, path: `${parent.path}/${slug}` }];
  }
  const app = /^app\/(.*?)\/?page\.(mdx?|tsx?)$/.exec(filePath);
  if (!app) return null;
  const dir = app[1].replace(/\/$/, "");
  if (!dir) return null;
  const route = `/${dir}`;
  if (route === "/blog") return [HOME, BLOG];
  if (route === "/glossary") return [HOME, GLOSSARY];
  if (route === "/compare") return [HOME, COMPARE];
  const page = getDocPage(route);
  const name = page?.title ?? title ?? dir;
  const [top, ...rest] = dir.split("/");
  const section = SECTIONS[top];
  if (section) return rest.length ? [HOME, section, { name, path: route }] : [HOME, section];
  if (TOP_LEVEL.has(route)) return [HOME, { name, path: route }];
  if (route.startsWith("/compare/")) return [HOME, COMPARE, { name, path: route }];
  return [HOME, DOCS, { name, path: route }];
}
