// Open Graph images, rendered at build time with next/og.
// One template for the whole site: dark canvas, dot grid, a faint graph on the right, the
// brand mark, a mono eyebrow and the page title. Each docs route has an `opengraph-image.tsx`
// that calls `docsOgImage("<folder>")`, which reads the title from that page's MDX.
//
// Fonts: Instrument Sans and JetBrains Mono (SIL Open Font License), bundled in assets/fonts
// because Satori needs TTF/OTF data rather than CSS.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND } from "./logo";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

const FONT_DIR = join(process.cwd(), "assets", "fonts");

async function fonts() {
  const [regular, semibold, mono] = await Promise.all([
    readFile(join(FONT_DIR, "InstrumentSans-Regular.ttf")),
    readFile(join(FONT_DIR, "InstrumentSans-SemiBold.ttf")),
    readFile(join(FONT_DIR, "JetBrainsMono-Medium.ttf")),
  ]);
  return [
    { name: "Instrument Sans", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Instrument Sans", data: semibold, weight: 600 as const, style: "normal" as const },
    { name: "JetBrains Mono", data: mono, weight: 500 as const, style: "normal" as const },
  ];
}

// A small fixed graph, drawn in the right half of the card.
const NODES: [number, number, "mint" | "violet" | "dim"][] = [
  [140, 110, "dim"],
  [330, 70, "dim"],
  [250, 250, "mint"],
  [440, 220, "dim"],
  [120, 380, "dim"],
  [360, 420, "violet"],
  [520, 360, "dim"],
  [230, 540, "dim"],
  [470, 560, "dim"],
];
const EDGES: [number, number, boolean][] = [
  [0, 2, false],
  [1, 2, false],
  [1, 3, false],
  [2, 3, false],
  [2, 4, false],
  [2, 5, true],
  [3, 6, false],
  [5, 6, false],
  [4, 7, false],
  [5, 7, false],
  [5, 8, false],
  [6, 8, false],
];

function Graph() {
  return (
    <svg width="600" height="630" viewBox="0 0 600 630" fill="none">
      <defs>
        <linearGradient id="hot" x1="250" y1="250" x2="360" y2="420" gradientUnits="userSpaceOnUse">
          <stop stopColor={BRAND.mint} />
          <stop offset="1" stopColor={BRAND.violet} />
        </linearGradient>
      </defs>
      {EDGES.map(([a, b, hot]) => (
        <line
          key={`${a}-${b}`}
          x1={NODES[a][0]}
          y1={NODES[a][1]}
          x2={NODES[b][0]}
          y2={NODES[b][1]}
          stroke={hot ? "url(#hot)" : "#ffffff"}
          strokeOpacity={hot ? 1 : 0.1}
          strokeWidth={hot ? 3 : 1.5}
        />
      ))}
      {NODES.map(([x, y, kind]) => (
        <circle
          key={`${x}-${y}`}
          cx={x}
          cy={y}
          r={kind === "dim" ? 9 : 13}
          fill={kind === "dim" ? "#141418" : BRAND.ink}
          stroke={kind === "mint" ? BRAND.mint : kind === "violet" ? BRAND.violet : "#ffffff"}
          strokeOpacity={kind === "dim" ? 0.18 : 1}
          strokeWidth={kind === "dim" ? 1.5 : 3}
        />
      ))}
    </svg>
  );
}

function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <defs>
        <linearGradient id="e" x1="16" y1="8" x2="16" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor={BRAND.mint} />
          <stop offset="1" stopColor={BRAND.violet} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={BRAND.ink} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" stroke="#ffffff" strokeOpacity="0.16" />
      <path
        d="M22.5 9C15 9 9.5 11 9.5 16S15 23 22.5 23"
        stroke="url(#e)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="22.5" cy="9" r="3" fill={BRAND.ink} stroke={BRAND.mint} strokeWidth="2" />
      <circle cx="22.5" cy="23" r="3" fill={BRAND.ink} stroke={BRAND.violet} strokeWidth="2" />
      <circle cx="9.5" cy="16" r="3.6" fill={BRAND.mint} />
    </svg>
  );
}

// Satori renders CSS radial gradients and repeated backgrounds unreliably, so the glow and the
// dot grid are drawn as SVG.
function Backdrop() {
  const dots = [];
  for (let x = 16; x < 1200; x += 32) {
    for (let y = 16; y < 630; y += 32) dots.push(<circle key={`${x}-${y}`} cx={x} cy={y} r="1" />);
  }
  return (
    <svg width="1200" height="630" viewBox="0 0 1200 630">
      <defs>
        <radialGradient id="glow" cx="0.18" cy="0.05" r="0.75">
          <stop offset="0" stopColor={BRAND.mint} stopOpacity="0.2" />
          <stop offset="0.5" stopColor={BRAND.violet} stopOpacity="0.05" />
          <stop offset="1" stopColor="#09090b" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g fill="#ffffff" fillOpacity="0.035">
        {dots}
      </g>
      <rect width="1200" height="630" fill="url(#glow)" />
    </svg>
  );
}

function truncate(text: string | undefined, max: number) {
  if (!text || text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,.:;]$/, "")}…`;
}

export type OgContent = { eyebrow: string; title: string; description?: string };

export async function renderOgImage({ eyebrow, title, description }: OgContent) {
  const desc = truncate(description, 120);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        backgroundColor: "#09090b",
        fontFamily: "Instrument Sans",
        color: "#fafafa",
      }}
    >
      <div style={{ position: "absolute", left: 0, top: 0, display: "flex" }}>
        <Backdrop />
      </div>
      <div style={{ position: "absolute", right: -40, top: 0, display: "flex" }}>
        <Graph />
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          width: "100%",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <Mark size={56} />
          <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: -1 }}>cyphra</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", maxWidth: 700 }}>
          <div
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 22,
              color: BRAND.mint,
              letterSpacing: 2,
              textTransform: "uppercase",
              marginBottom: 22,
            }}
          >
            {eyebrow}
          </div>
          <div
            style={{
              fontSize: title.length > 36 ? 58 : title.length > 18 ? 68 : 76,
              fontWeight: 600,
              lineHeight: 1.05,
              letterSpacing: -2.5,
            }}
          >
            {title}
          </div>
          {desc ? (
            <div
              style={{
                fontSize: 26,
                lineHeight: 1.4,
                color: "#a1a1aa",
                marginTop: 26,
                maxWidth: 620,
              }}
            >
              {desc}
            </div>
          ) : null}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 24,
            color: "#a1a1aa",
          }}
        >
          <div style={{ display: "flex" }}>cyphra.dev</div>
          <div
            style={{
              display: "flex",
              fontFamily: "JetBrains Mono",
              fontSize: 22,
              color: "#e4e4e7",
              padding: "10px 18px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.14)",
              backgroundColor: "#141418",
            }}
          >
            <span style={{ color: BRAND.mint, marginRight: 12 }}>$</span>npm i cyphra
          </div>
        </div>
      </div>
    </div>,
    { ...OG_SIZE, fonts: await fonts() },
  );
}

/** Reads the title (frontmatter `title`, else the first `# heading`) and description of a docs page. */
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

export async function docsOgImage(folder: string) {
  const { title, description } = await readPage(folder);
  return renderOgImage({ eyebrow: "Cyphra docs", title, description });
}
