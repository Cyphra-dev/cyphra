/**
 * SEO audit: crawls the sitemap of a running build of the site and checks the invariants that
 * silently hurt search and link previews. Ported from the website template, without i18n.
 *
 * Errors (exit code 1):
 *   1. Canonical: exactly one <link rel="canonical">, pointing at the page itself.
 *   2. Robots: no noindex on a sitemap URL, at most one robots meta tag.
 *   3. Basics: one non-empty <title>, a meta description, exactly one <h1>, og:image (that loads),
 *      og:url equal to the canonical, a twitter:card, and the RSS <link rel="alternate">.
 *   4. JSON-LD: every block parses and has @context and @type; FAQPage questions and answers and
 *      HowTo steps are visible on the page (and each step's #anchor exists); a BreadcrumbList ends
 *      at the page itself.
 *   5. Internal links: every same-site link resolves (200), its #fragment exists on the target,
 *      and every indexable internal page that is linked is also in the sitemap.
 *   6. Site files: robots.txt points at the sitemap, the sitemap and feed are well-formed XML,
 *      llms.txt / llms-full.txt are served, security.txt has Contact and a future Expires and no
 *      email address.
 *
 * Warnings (reported, never fail the run): titles over 60 characters, descriptions outside
 * 50–160 characters, titles or descriptions shared by several pages.
 *
 * Usage (from doc/):
 *   pnpm build && pnpm start          # then, in another terminal:
 *   pnpm seo:audit [baseUrl]          # default http://localhost:3000
 */
const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const SITE_ORIGINS = ["https://www.cyphra.dev", "https://cyphra.dev"];

type Finding = { url: string; rule: string; message: string };
const errors: Finding[] = [];
const warnings: Finding[] = [];
const error = (url: string, rule: string, message: string) => errors.push({ url, rule, message });
const warn = (url: string, rule: string, message: string) => warnings.push({ url, rule, message });

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();

/** Text a reader can see: scripts, styles and tags removed, whitespace collapsed. */
function visibleText(html: string): string {
  return normalizeText(
    decodeEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function matchAll(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1] ?? m[0]);
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? decodeEntities(m[1] ?? m[2] ?? "") : undefined;
}

function metaContent(html: string, key: string): string[] {
  return matchAll(html, /<meta\s[^>]*>/gi)
    .filter((tag) => (attr(tag, "name") ?? attr(tag, "property"))?.toLowerCase() === key)
    .map((tag) => attr(tag, "content") ?? "");
}

/** Maps a production URL (or a path) onto the audited server, without the fragment. */
function onBase(raw: string): string {
  const u = new URL(raw, BASE);
  const b = new URL(BASE);
  u.protocol = b.protocol;
  u.host = b.host;
  u.hash = "";
  return u.toString().replace(/\/$/, "") || u.toString();
}

function isSiteUrl(href: string): boolean {
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  return SITE_ORIGINS.some(
    (o) => href === o || href.startsWith(`${o}/`) || href.startsWith(`${o}#`),
  );
}

const pageCache = new Map<string, Promise<{ status: number; html: string; type: string }>>();
function fetchPage(url: string) {
  if (!pageCache.has(url)) {
    pageCache.set(
      url,
      fetch(url, { redirect: "follow" }).then(async (res) => ({
        status: res.status,
        type: res.headers.get("content-type") ?? "",
        html: await res.text(),
      })),
    );
  }
  return pageCache.get(url)!;
}

async function getText(url: string): Promise<string> {
  const page = await fetchPage(url);
  if (page.status !== 200) throw new Error(`${page.status} ${url}`);
  return page.html;
}

/** Raw `&` that is not an entity breaks XML parsers ("EntityRef: expecting ';'"). */
function checkXml(xml: string, source: string): void {
  const bad = xml.match(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/);
  if (bad) {
    const at = xml.slice(Math.max(0, bad.index! - 40), bad.index! + 40).replace(/\n/g, " ");
    error(source, "xml", `unescaped '&' near: …${at}…`);
  }
  if (!xml.trimStart().startsWith("<?xml")) error(source, "xml", "missing XML declaration");
}

async function collectSitemapUrls(): Promise<string[]> {
  const xml = await getText(`${BASE}/sitemap.xml`);
  checkXml(xml, `${BASE}/sitemap.xml`);
  return [...new Set(matchAll(xml, /<loc>([^<]+)<\/loc>/g).map(onBase))];
}

const titles = new Map<string, string[]>();
const descriptions = new Map<string, string[]>();
/** Internal link target (no fragment) → fragments requested and the pages linking to it. */
const links = new Map<string, { fragments: Set<string>; from: Set<string> }>();
const ogImages = new Map<string, string>();

function auditJsonLd(url: string, html: string, canonical: string | undefined): void {
  const blocks = matchAll(
    html,
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  if (blocks.length === 0) error(url, "jsonld", "no JSON-LD on the page");
  const visible = visibleText(html);
  for (const block of blocks) {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(block);
    } catch {
      error(url, "jsonld", `JSON-LD failed to parse: ${block.slice(0, 80)}`);
      continue;
    }
    if (json["@context"] !== "https://schema.org") {
      error(
        url,
        "jsonld",
        `@context should be https://schema.org, got ${String(json["@context"])}`,
      );
    }
    const nodes = (json["@graph"] as Record<string, unknown>[] | undefined) ?? [json];
    for (const node of nodes) {
      if (!node["@type"]) error(url, "jsonld", "JSON-LD node without @type");
      if (node["@type"] === "FAQPage") {
        type Question = { name?: string; acceptedAnswer?: { text?: string } };
        for (const q of (node.mainEntity as Question[] | undefined) ?? []) {
          if (q?.name && !visible.includes(normalizeText(q.name))) {
            error(url, "jsonld-visible", `FAQ question not visible: "${q.name.slice(0, 60)}"`);
          }
          const answer = q?.acceptedAnswer?.text;
          if (answer && !visible.includes(normalizeText(answer))) {
            error(url, "jsonld-visible", `FAQ answer not visible: "${answer.slice(0, 60)}"`);
          }
        }
      }
      if (node["@type"] === "HowTo") {
        for (const step of (node.step as { name?: string; url?: string }[] | undefined) ?? []) {
          if (step?.name && !visible.includes(normalizeText(step.name))) {
            error(url, "jsonld-visible", `HowTo step not visible: "${step.name.slice(0, 60)}"`);
          }
          const id = step?.url ? new URL(step.url).hash.slice(1) : "";
          if (id && !new RegExp(`\\sid=["']${id}["']`).test(html)) {
            error(url, "jsonld-visible", `HowTo step anchor #${id} not found`);
          }
        }
      }
      if (node["@type"] === "BreadcrumbList") {
        const items = (node.itemListElement as { item?: string; position?: number }[]) ?? [];
        const last = items.at(-1)?.item;
        if (!last || (canonical && onBase(last) !== onBase(canonical))) {
          error(url, "jsonld-breadcrumb", `last breadcrumb ${last} is not the page itself`);
        }
        items.forEach((it, i) => {
          if (it.position !== i + 1) error(url, "jsonld-breadcrumb", "positions must be 1..n");
        });
      }
      for (const key of ["aggregateRating", "review"]) {
        if (key in node) error(url, "jsonld", `${key} found: only add ratings that exist`);
      }
    }
  }
}

async function auditPage(url: string): Promise<void> {
  const html = await getText(url);

  // 1. Canonical.
  const canonicals = matchAll(html, /<link[^>]+rel=["']canonical["'][^>]*>/gi);
  if (canonicals.length !== 1) {
    error(url, "canonical", `expected 1 canonical, found ${canonicals.length}`);
  }
  const canonical = canonicals[0] && attr(canonicals[0], "href");
  if (canonical && onBase(canonical) !== url) {
    error(url, "canonical", `canonical points elsewhere: ${canonical}`);
  }

  // 2. Robots.
  const robots = metaContent(html, "robots");
  if (robots.length > 1) error(url, "robots", `${robots.length} robots meta tags`);
  if (robots.some((r) => /noindex/i.test(r))) error(url, "robots", "noindex page in the sitemap");

  // 3. Basics.
  const titleTags = matchAll(html, /<title[^>]*>([\s\S]*?)<\/title>/gi).map((t) =>
    normalizeText(decodeEntities(t)),
  );
  if (titleTags.length !== 1 || !titleTags[0]) {
    error(url, "title", `expected 1 non-empty <title>, found ${titleTags.length}`);
  } else {
    const title = titleTags[0];
    if (title.length > 60) warn(url, "title-length", `${title.length} chars (> 60): "${title}"`);
    titles.set(title, [...(titles.get(title) ?? []), url]);
  }
  const description = metaContent(html, "description")[0];
  if (!description) {
    error(url, "description", "missing meta description");
  } else {
    if (description.length < 50 || description.length > 160) {
      warn(url, "description-length", `${description.length} chars (want 50–160)`);
    }
    descriptions.set(description, [...(descriptions.get(description) ?? []), url]);
  }
  // Count <h1> elements outside <script>/<template> (Nextra inlines RSC payloads).
  const markup = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const h1s = matchAll(markup, /<h1[\s>]/gi).length;
  if (h1s !== 1) error(url, "h1", `expected 1 <h1>, found ${h1s}`);
  const ogImage = metaContent(html, "og:image")[0];
  if (!ogImage) error(url, "og", "missing og:image");
  else ogImages.set(onBase(ogImage.replace(/\?.*$/, "")), url);
  const ogUrl = metaContent(html, "og:url")[0];
  if (!ogUrl) error(url, "og", "missing og:url");
  else if (canonical && onBase(ogUrl) !== onBase(canonical)) {
    error(url, "og", `og:url ${ogUrl} ≠ canonical ${canonical}`);
  }
  if (!metaContent(html, "twitter:card")[0]) error(url, "twitter", "missing twitter:card");
  if (!/<link[^>]+type=["']application\/rss\+xml["'][^>]*>/i.test(html)) {
    error(url, "rss", "missing <link rel=alternate type=application/rss+xml>");
  }

  // 4. Structured data.
  auditJsonLd(url, html, canonical);

  // 5. Collect internal links.
  for (const tag of matchAll(markup, /<a\s[^>]*>/gi)) {
    const href = attr(tag, "href");
    if (!href || !isSiteUrl(href)) continue;
    const target = onBase(href);
    const fragment = new URL(href, BASE).hash.slice(1);
    const entry = links.get(target) ?? { fragments: new Set(), from: new Set() };
    if (fragment) entry.fragments.add(decodeURIComponent(fragment));
    entry.from.add(url);
    links.set(target, entry);
  }
}

async function auditLinks(sitemap: Set<string>): Promise<void> {
  for (const [target, { fragments, from }] of links) {
    const source = [...from][0];
    let page;
    try {
      page = await fetchPage(target);
    } catch (e) {
      error(target, "link", `could not fetch (linked from ${source}): ${(e as Error).message}`);
      continue;
    }
    if (page.status !== 200) {
      error(target, "broken-link", `HTTP ${page.status}, linked from ${[...from].join(", ")}`);
      continue;
    }
    for (const id of fragments) {
      if (
        !new RegExp(`\\sid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(page.html)
      ) {
        error(target, "broken-anchor", `#${id} not found, linked from ${source}`);
      }
    }
    const isHtml = page.type.includes("text/html");
    if (isHtml && !sitemap.has(target)) {
      const robots = metaContent(page.html, "robots");
      if (!robots.some((r) => /noindex/i.test(r))) {
        error(target, "sitemap-missing", `indexable page linked from ${source} but not in sitemap`);
      }
    }
  }
}

async function auditSiteFiles(): Promise<void> {
  const robots = await getText(`${BASE}/robots.txt`).catch(() => "");
  if (!/^Sitemap:\s*\S+\/sitemap\.xml$/m.test(robots)) {
    error(`${BASE}/robots.txt`, "robots-txt", "no Sitemap: line");
  }

  const feed = await getText(`${BASE}/feed.xml`).catch((e) => {
    error(`${BASE}/feed.xml`, "feed", (e as Error).message);
    return "";
  });
  if (feed) {
    checkXml(feed, `${BASE}/feed.xml`);
    const items = matchAll(feed, /<link>([^<]+)<\/link>/g).map(onBase);
    for (const item of items) {
      const res = await fetchPage(item);
      if (res.status !== 200)
        error(`${BASE}/feed.xml`, "feed", `item ${item} returns ${res.status}`);
    }
  }

  for (const path of ["/llms.txt", "/llms-full.txt"]) {
    const body = await getText(`${BASE}${path}`).catch(() => "");
    if (!body.startsWith("# "))
      error(`${BASE}${path}`, "llms", "missing or does not start with an H1");
    if (path === "/llms.txt") {
      for (const md of matchAll(body, /\]\((https?:\/\/[^)]+\.md)\)/g)) {
        const res = await fetchPage(onBase(md));
        if (res.status !== 200) error(`${BASE}${path}`, "llms", `${md} returns ${res.status}`);
      }
    }
  }

  const security = await getText(`${BASE}/.well-known/security.txt`).catch(() => "");
  const where = `${BASE}/.well-known/security.txt`;
  if (!/^Contact: \S+/m.test(security)) error(where, "security-txt", "missing Contact");
  const expires = /^Expires: (\S+)$/m.exec(security)?.[1];
  if (!expires || !(new Date(expires).getTime() > Date.now())) {
    error(where, "security-txt", "missing or past Expires");
  }
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(security))
    error(where, "security-txt", "contains an email address");

  for (const [img, page] of ogImages) {
    const res = await fetch(img);
    const type = res.headers.get("content-type") ?? "";
    if (res.status !== 200 || !type.startsWith("image/")) {
      error(img, "og-image", `HTTP ${res.status} ${type} (from ${page})`);
    }
  }
}

async function main() {
  console.log(`SEO audit against ${BASE}`);
  const urls = await collectSitemapUrls();
  console.log(`Auditing ${urls.length} URLs from the sitemap.`);
  for (const url of urls) {
    try {
      await auditPage(url);
    } catch (e) {
      error(url, "fetch", (e as Error).message);
    }
  }
  await auditLinks(new Set(urls));
  await auditSiteFiles();

  for (const [map, rule] of [
    [titles, "duplicate-title"],
    [descriptions, "duplicate-description"],
  ] as const) {
    for (const [text, pages] of map) {
      if (pages.length > 1) warn(pages.join(", "), rule, `"${text.slice(0, 80)}"`);
    }
  }

  for (const w of warnings) console.warn(`  ! ${w.url}\n    [${w.rule}] ${w.message}`);
  if (errors.length === 0) {
    console.log(
      `✓ no SEO errors across ${urls.length} pages and ${links.size} internal links (${warnings.length} warning(s))`,
    );
    process.exit(0);
  }
  for (const e of errors) console.error(`  ✗ ${e.url}\n    [${e.rule}] ${e.message}`);
  console.error(`\n${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(1);
}

main();
