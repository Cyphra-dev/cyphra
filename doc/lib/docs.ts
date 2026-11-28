// An index of the MDX docs pages (app/**/page.mdx), read at build time: routes, titles,
// descriptions and a plain-Markdown version of each body. Used by llms.txt, llms-full.txt, the
// per-page `.md` routes, breadcrumbs and the sitemap.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import matter from "gray-matter";
import meta from "../app/_meta";
import { FAQ, INCLUDED, PLANS } from "../components/pricing/plans";

const APP_DIR = join(process.cwd(), "app");

export type DocPage = {
  /** "/schema"; "/" for the landing page. */
  route: string;
  /** "app/schema/page.mdx" */
  file: string;
  /** Short title: the sidebar title from _meta, else frontmatter sidebarTitle, else the H1. */
  title: string;
  /** Full SEO title from frontmatter, if any. */
  seoTitle?: string;
  description: string;
  /** Sidebar group ("Start here", "Core", ...), from the _meta separators. */
  section?: string;
  /** The page as plain Markdown (imports and JSX removed). */
  markdown: string;
};

type MetaValue = string | { title?: unknown; type?: string; display?: string; href?: string };

function metaTitle(key: string): string | undefined {
  const value = (meta as Record<string, MetaValue>)[key];
  if (typeof value === "string") return value;
  return typeof value?.title === "string" ? value.title : undefined;
}

/** Sidebar order and group of each top-level key in app/_meta.ts. */
function metaOrder(): Map<string, { index: number; section?: string }> {
  const out = new Map<string, { index: number; section?: string }>();
  let section: string | undefined;
  Object.entries(meta as Record<string, MetaValue>).forEach(([key, value], index) => {
    if (typeof value === "object" && value?.type === "separator") {
      section = typeof value.title === "string" ? value.title : undefined;
      return;
    }
    out.set(key, { index, section });
  });
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!/^[_[(.]/.test(name)) out.push(...walk(full));
    } else if (name === "page.mdx") out.push(full);
  }
  return out;
}

/** Removes MDX-only syntax (imports, exports, JSX components) and keeps the prose and code. */
export function mdxToMarkdown(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  let depth = 0;
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (fenceMatch && fenceMatch[1].startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      // Drop Nextra fence meta (filename="…") but keep the language.
      out.push(line.replace(/^(\s*[`~]{3,}[\w-]*)\s.*$/, "$1"));
      continue;
    }
    if (/^\s*(import|export)\s/.test(line)) continue;
    // <Cards.Card title="Schema" href="/schema" /> → a Markdown link.
    const card = /<Cards\.Card\s[^>]*title="([^"]+)"[^>]*href="([^"]+)"[^>]*\/>/.exec(line);
    if (card) {
      out.push(`- [${card[1]}](${card[2]})`);
      continue;
    }
    // Track open component blocks (<Callout>…</Callout>) to un-indent their children.
    const opens = (line.match(/<[A-Z][\w.]*(\s[^>]*)?(?<!\/)>/g) ?? []).length;
    const closes = (line.match(/<\/[A-Z][\w.]*>/g) ?? []).length;
    const stripped = line
      .replace(/<\/?[A-Z][\w.]*(\s[^>]*)?\/?>/g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    depth = Math.max(0, depth + opens - closes);
    if (stripped.trim() === "" && line.trim() !== "") continue;
    out.push(depth > 0 ? stripped.replace(/^ {2}/, "") : stripped);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Markdown for the pages whose body is a React component. */
function componentPageMarkdown(route: string, description: string): string | undefined {
  if (route === "/pricing") {
    const plans = PLANS.map((p) => {
      const specs = Object.entries(p.specs)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      return `- **${p.name}**: ${p.price}${p.period}. ${p.desc} ${specs}.`;
    }).join("\n");
    const faq = FAQ.map(([q, a]) => `### ${q}\n\n${a}`).join("\n\n");
    return [
      "# Cyphra Cloud pricing",
      description,
      "## Plans",
      plans,
      "Prices in USD, per database per month, excluding taxes. Early-access plans and prices may change.",
      "## Every plan includes",
      INCLUDED.map((f) => `- ${f}`).join("\n"),
      "## Questions",
      faq,
    ].join("\n\n");
  }
  if (route === "/") {
    return [
      "# Cyphra: the typed OGM for Neo4j",
      description,
      "- [Getting started](/getting-started)",
      "- [Schema](/schema)",
      "- [Typed client](/client)",
      "- [Migrations](/migrations)",
      "- [CLI](/cli)",
      "- [Cyphra Cloud](/cloud) and [pricing](/pricing)",
    ].join("\n\n");
  }
  return undefined;
}

let pages: DocPage[] | undefined;

export function getDocPages(): DocPage[] {
  if (pages) return pages;
  const order = metaOrder();
  pages = walk(APP_DIR)
    .map((full) => {
      const dir = relative(APP_DIR, join(full, "..")).split("\\").join("/");
      const route = dir ? `/${dir}` : "/";
      const raw = readFileSync(full, "utf8");
      const { data, content } = matter(raw);
      const h1 = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
      const key = dir || "index";
      const description = typeof data.description === "string" ? data.description : "";
      const title =
        (dir ? metaTitle(key) : undefined) ??
        (typeof data.sidebarTitle === "string" ? data.sidebarTitle : undefined) ??
        h1 ??
        (typeof data.title === "string" ? data.title : key);
      return {
        route,
        file: `app/${dir ? `${dir}/` : ""}page.mdx`,
        title: route === "/" ? "Home" : title,
        seoTitle: typeof data.title === "string" ? data.title : undefined,
        description,
        section: order.get(key)?.section,
        markdown: componentPageMarkdown(route, description) ?? mdxToMarkdown(content),
        sort: order.get(key)?.index ?? 999,
      };
    })
    .sort((a, b) => a.sort - b.sort || a.route.localeCompare(b.route))
    .map(({ sort: _sort, ...page }) => page);
  return pages;
}

export function getDocPage(route: string): DocPage | undefined {
  return getDocPages().find((p) => p.route === route);
}
