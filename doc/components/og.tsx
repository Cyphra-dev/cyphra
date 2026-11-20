// Open Graph images, rendered at build time with next/og.
//
// One template for the whole site (see DESIGN.md, "Open Graph"): deep black, the lockup and a
// section label at the top, a huge title, and one thin schematic line along the bottom that
// starts at a node and ends in the signal arrow, captioned with the page as a Cypher pattern.
// Each route has an `opengraph-image.tsx` that calls `renderOgImage` or `docsOgImage`.
//
// Fonts (SIL Open Font License), bundled in assets/fonts because Satori needs TTF data:
// Schibsted Grotesk SemiBold (titles), Inter Regular (description), Geist Mono Medium (labels).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND, markPaths, WORDMARK } from "./logo";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

const FONT_DIR = join(process.cwd(), "assets", "fonts");

async function fonts() {
  const [display, text, mono] = await Promise.all([
    readFile(join(FONT_DIR, "SchibstedGrotesk-SemiBold.ttf")),
    readFile(join(FONT_DIR, "Inter-Regular.ttf")),
    readFile(join(FONT_DIR, "GeistMono-Medium.ttf")),
  ]);
  return [
    { name: "Schibsted Grotesk", data: display, weight: 600 as const, style: "normal" as const },
    { name: "Inter", data: text, weight: 400 as const, style: "normal" as const },
    { name: "Geist Mono", data: mono, weight: 500 as const, style: "normal" as const },
  ];
}

function Lockup({ height }: { height: number }) {
  const width = Math.round((WORDMARK.width * height) / 112);
  return (
    <svg width={width} height={height} viewBox={`0 -82 ${WORDMARK.width} 112`}>
      <g transform={`translate(0 -80) scale(${108 / 32})`} fill="none">
        {markPaths(BRAND.bone, BRAND.signal)}
      </g>
      <path transform={`translate(${WORDMARK.x} 0)`} fill={BRAND.bone} d={WORDMARK.d} />
    </svg>
  );
}

/** The schematic edge: a hollow node, a hairline, and the signal arrowhead. */
function Edge() {
  return (
    <svg width="1040" height="28" viewBox="0 0 1040 28" fill="none">
      <circle cx="9" cy="14" r="7" stroke={BRAND.stone} strokeWidth="2" />
      <path d="M16 14H1030" stroke="#3a3936" strokeWidth="2" />
      <path
        d="M1018 4.5 1031 14 1018 23.5"
        stroke={BRAND.signal}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function truncate(text: string | undefined, max: number) {
  if (!text || text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,.:;]$/, "")}…`;
}

export type OgContent = {
  /** Short section label next to the logo, e.g. "docs". */
  section?: string;
  title: string;
  description?: string;
  /** Caption under the edge, written as a Cypher pattern. */
  pattern: string;
};

export async function renderOgImage({ section, title, description, pattern }: OgContent) {
  const desc = truncate(description, 110);
  const titleSize = title.length > 34 ? 76 : title.length > 18 ? 92 : 116;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 80px 52px",
        backgroundColor: BRAND.black,
        color: BRAND.bone,
        fontFamily: "Inter",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <Lockup height={44} />
        {section ? (
          <div
            style={{
              display: "flex",
              fontFamily: "Geist Mono",
              fontSize: 24,
              color: BRAND.stone,
              marginTop: 2,
            }}
          >
            / {section}
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", maxWidth: 1000 }}>
        <div
          style={{
            fontFamily: "Schibsted Grotesk",
            fontSize: titleSize,
            fontWeight: 600,
            lineHeight: 1,
            letterSpacing: -titleSize * 0.045,
          }}
        >
          {title}
        </div>
        {desc ? (
          <div
            style={{
              fontSize: 28,
              lineHeight: 1.4,
              color: BRAND.stone,
              marginTop: 28,
              maxWidth: 900,
            }}
          >
            {desc}
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <Edge />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: "Geist Mono",
            fontSize: 22,
            color: BRAND.stone,
          }}
        >
          <div style={{ display: "flex" }}>{pattern}</div>
          <div style={{ display: "flex" }}>cyphra.dev</div>
        </div>
      </div>
    </div>,
    { ...OG_SIZE, fonts: await fonts() },
  );
}

/** Reads the title (frontmatter `sidebarTitle`, else the first `# heading`, else `title`). */
async function readPage(folder: string) {
  const src = await readFile(join(process.cwd(), "app", folder, "page.mdx"), "utf8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(src)?.[1] ?? "";
  const field = (name: string) => {
    const raw = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(fm)?.[1]?.trim();
    return raw?.replace(/^["']|["']$/g, "");
  };
  const heading = /^#\s+(.+)$/m.exec(src.slice(fm.length))?.[1]?.trim();
  return {
    title: field("sidebarTitle") ?? heading ?? field("title") ?? folder,
    description: field("description"),
  };
}

const label = (title: string) =>
  title
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

/** OG image for an MDX page; the caption reads `(:Docs)-[:COVERS]->(:<Title>)`. */
export async function docsOgImage(
  folder: string,
  options: { section?: string; title?: string; pattern?: string } = {},
) {
  const page = await readPage(folder);
  const title = options.title ?? page.title;
  return renderOgImage({
    section: options.section ?? "docs",
    title,
    description: page.description,
    pattern: options.pattern ?? `(:Docs)-[:COVERS]->(:${label(title)})`,
  });
}
