// Blog posts and glossary terms: Markdown files with YAML frontmatter under content/.
//
// Nextra compiles the bodies (same code themes as the docs, see next.config.mjs) through its content
// directory, and the pages import them with `importPage`. This module only reads the frontmatter and
// raw text, for listings, feeds, sitemaps, llms.txt and JSON-LD. `scripts/lint-content.ts` checks
// the same fields.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

const CONTENT_DIR = join(process.cwd(), "content");

export type Post = {
  slug: string;
  path: string;
  title: string;
  description: string;
  date: string;
  updated?: string;
  author: string;
  tags: string[];
  body: string;
  readingMinutes: number;
};

export type Term = {
  slug: string;
  path: string;
  title: string;
  description: string;
  date: string;
  updated?: string;
  /** Other names for the term (DefinedTerm alternateName). */
  aliases: string[];
  /** Slugs of related glossary terms. */
  related: string[];
  body: string;
};

function str(value: unknown, field: string, file: string): string {
  // YAML parses unquoted dates as Date objects; keep them as ISO dates.
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${file}: frontmatter.${field} is required`);
  }
  return value.trim();
}

function optStr(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function readCollection(dir: string) {
  const full = join(CONTENT_DIR, dir);
  return readdirSync(full)
    .filter((f) => /\.mdx?$/.test(f))
    .sort()
    .map((file) => {
      const { data, content } = matter(readFileSync(join(full, file), "utf8"));
      return { file: `content/${dir}/${file}`, slug: file.replace(/\.mdx?$/, ""), data, content };
    });
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

let posts: Post[] | undefined;
let terms: Term[] | undefined;

/** All posts, newest first. */
export function getPosts(): Post[] {
  posts ??= readCollection("blog")
    .map(({ file, slug, data, content }) => ({
      slug,
      path: `/blog/${slug}`,
      title: str(data.title, "title", file),
      description: str(data.description, "description", file),
      date: str(data.date, "date", file),
      updated: optStr(data.updated),
      author: optStr(data.author) ?? "Cyphra team",
      tags: strList(data.tags),
      body: content.trim(),
      readingMinutes: Math.max(1, Math.round(words(content) / 230)),
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  return posts;
}

export function getPost(slug: string): Post | undefined {
  return getPosts().find((p) => p.slug === slug);
}

/** All glossary terms, A to Z. */
export function getTerms(): Term[] {
  terms ??= readCollection("glossary")
    .map(({ file, slug, data, content }) => ({
      slug,
      path: `/glossary/${slug}`,
      title: str(data.title, "title", file),
      description: str(data.description, "description", file),
      date: str(data.date, "date", file),
      updated: optStr(data.updated),
      aliases: strList(data.aliases),
      related: strList(data.related),
      body: content.trim(),
    }))
    .sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
  return terms;
}

export function getTerm(slug: string): Term | undefined {
  return getTerms().find((t) => t.slug === slug);
}

/** Every tag used by a post, with how many posts use it. */
export function getTags(): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of getPosts()) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

export function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
