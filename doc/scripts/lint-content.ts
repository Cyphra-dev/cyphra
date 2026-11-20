/**
 * Content lint for content/blog and content/glossary: catches the quality bugs that quietly hurt
 * SEO before anything is built. Ported from the website template (no i18n, no husky).
 *
 * Errors (exit code 1): missing or malformed frontmatter (title, description, ISO date, tags on
 * posts), a body H1 (the title is the page H1), skipped heading levels, images without alt text,
 * internal links to pages that do not exist, unknown `related` glossary slugs, and an
 * `updated` date before `date`.
 * Warnings: title over 60 characters, description outside 50–160 characters, short bodies.
 *
 * Usage (from doc/):
 *   pnpm lint:content                      # all content
 *   pnpm lint:content content/blog         # one collection
 *   pnpm lint:content content/blog/x.md    # one file
 */
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const ROOT = process.cwd();
const CONTENT = path.join(ROOT, "content");
const APP = path.join(ROOT, "app");

/** Minimum body words per collection: glossary entries are definitions, not articles. */
const MIN_WORDS: Record<string, number> = { blog: 600, glossary: 80 };

type Severity = "error" | "warn";
type Finding = { file: string; line?: number; severity: Severity; rule: string; message: string };

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function targets(args: string[]): string[] {
  if (args.length === 0) return walk(CONTENT);
  return args.flatMap((arg) => {
    const full = path.resolve(ROOT, arg);
    if (!fs.existsSync(full)) return [];
    return fs.statSync(full).isDirectory() ? walk(full) : /\.mdx?$/.test(full) ? [full] : [];
  });
}

/** Every route the site serves: app/**\/page.* (static segments) plus content files. */
function knownRoutes(): Set<string> {
  const routes = new Set<string>();
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!/^[_[(]/.test(entry.name)) visit(path.join(dir, entry.name));
      } else if (/^page\.(mdx?|tsx?)$/.test(entry.name)) {
        const rel = path.relative(APP, dir).split(path.sep).join("/");
        routes.add(rel ? `/${rel}` : "/");
      }
    }
  };
  visit(APP);
  for (const file of walk(CONTENT)) {
    routes.add(
      `/${path
        .relative(CONTENT, file)
        .split(path.sep)
        .join("/")
        .replace(/\.mdx?$/, "")}`,
    );
  }
  return routes;
}

const ROUTES = knownRoutes();
const GLOSSARY_SLUGS = new Set(
  walk(path.join(CONTENT, "glossary")).map((f) => path.basename(f).replace(/\.mdx?$/, "")),
);

/** Lines outside fenced code blocks, with their 1-based line numbers. */
function* proseLines(content: string, offset: number): Generator<{ line: number; text: string }> {
  let fence = false;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fence = !fence;
      continue;
    }
    if (!fence) yield { line: i + 1 + offset, text: lines[i] };
  }
}

function wordCount(content: string): number {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[#*_>[\]()!\\-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

function isIsoDate(value: unknown): boolean {
  const s = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function lintFile(file: string): Finding[] {
  const findings: Finding[] = [];
  const add = (severity: Severity, rule: string, message: string, line?: number) =>
    findings.push({ file, line, severity, rule, message });
  const raw = fs.readFileSync(file, "utf8");
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    add("error", "frontmatter-parse", (err as Error).message);
    return findings;
  }
  const fm = parsed.data as Record<string, unknown>;
  const collection = path.relative(CONTENT, file).split(path.sep)[0];
  // Line offset of the body inside the file, so reported lines match the editor.
  const offset = raw.slice(0, raw.length - parsed.content.length).split("\n").length - 1;

  // Frontmatter.
  for (const key of ["title", "description"]) {
    if (typeof fm[key] !== "string" || !(fm[key] as string).trim()) {
      add("error", "required-frontmatter", `frontmatter.${key} is required (string)`);
    }
  }
  if (!isIsoDate(fm.date))
    add("error", "date", "frontmatter.date must be an ISO date (YYYY-MM-DD)");
  if (fm.updated !== undefined) {
    if (!isIsoDate(fm.updated)) add("error", "date", "frontmatter.updated must be YYYY-MM-DD");
    else if (String(fm.updated) < String(fm.date)) add("error", "date", "updated is before date");
  }
  if (collection === "blog") {
    if (
      !Array.isArray(fm.tags) ||
      fm.tags.length === 0 ||
      fm.tags.some((t) => typeof t !== "string")
    ) {
      add("error", "tags", "frontmatter.tags must be a non-empty list of strings");
    }
  }
  if (collection === "glossary" && fm.related !== undefined) {
    const related = Array.isArray(fm.related) ? fm.related : [];
    for (const slug of related) {
      if (!GLOSSARY_SLUGS.has(String(slug)))
        add("error", "related", `unknown glossary term "${slug}"`);
    }
  }
  if (typeof fm.title === "string" && fm.title.length > 60) {
    add("warn", "title-length", `title is ${fm.title.length} chars; Google truncates around 60`);
  }
  if (typeof fm.description === "string") {
    const len = fm.description.length;
    if (len < 50 || len > 160)
      add("warn", "description-length", `description is ${len} chars (want 50–160)`);
  }

  // Body: headings, images and links (outside code blocks).
  let prevDepth = 1; // the frontmatter title is the page H1
  let sawH2 = false;
  for (const { line, text } of proseLines(parsed.content, offset)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (heading) {
      const depth = heading[1].length;
      if (depth === 1)
        add("error", "no-body-h1", `body H1 "${heading[2]}": the title is the H1`, line);
      else if (depth > prevDepth + 1) {
        add(
          "error",
          "heading-skip",
          `H${depth} "${heading[2]}" skips a level (after H${prevDepth})`,
          line,
        );
      }
      if (depth === 2) sawH2 = true;
      prevDepth = depth;
    }
    const inline = text.replace(/`[^`]*`/g, "");
    for (const m of inline.matchAll(/!\[([^\]]*)\]\(([^)\s]*)/g)) {
      if (!m[2]) add("error", "image-src", `image without src: ${m[0]}`, line);
      if (!m[1].trim()) add("error", "image-alt", `image without alt text: ${m[0]}`, line);
    }
    for (const m of inline.matchAll(/(?<!!)\[[^\]]*\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g)) {
      const route = m[1].replace(/\/$/, "") || "/";
      if (!ROUTES.has(route)) add("error", "broken-link", `link to unknown page ${m[1]}`, line);
    }
  }
  if (!sawH2) add("warn", "no-h2", "no H2: sections give readers and search engines structure");

  const words = wordCount(parsed.content);
  const minimum = MIN_WORDS[collection] ?? 300;
  if (words < minimum)
    add("warn", "word-count", `${words} words; ${collection} minimum is ${minimum}`);

  return findings;
}

function main() {
  const files = targets(process.argv.slice(2));
  if (files.length === 0) {
    console.log("No Markdown files to lint.");
    return;
  }
  const findings = files.flatMap(lintFile);
  for (const f of findings) {
    const where = `${path.relative(ROOT, f.file)}${f.line ? `:${f.line}` : ""}`;
    const tag = f.severity === "error" ? "\x1b[31merror\x1b[0m" : "\x1b[33mwarn\x1b[0m";
    console.log(`  ${tag}  ${where}  [${f.rule}]  ${f.message}`);
  }
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warnCount = findings.length - errorCount;
  console.log(
    findings.length === 0
      ? `✓ ${files.length} file(s) linted, no issues`
      : `\n${errorCount} error(s), ${warnCount} warning(s) across ${files.length} file(s).`,
  );
  process.exit(errorCount > 0 ? 1 : 0);
}

main();
