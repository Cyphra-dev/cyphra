// Site-wide identity, shared by metadata, JSON-LD, feeds and llms.txt.
import { LINKS, SITE_URL } from "../components/links";

export const SITE = {
  name: "Cyphra",
  legalName: "FAKGROUP",
  url: SITE_URL,
  description:
    "Cyphra is the typed OGM (object-graph mapper) for Neo4j: a .cyphra schema, a fully typed TypeScript client and migrations generated from schema changes. Open source, MIT.",
  // Raster logo: Google wants a bitmap of at least 112 px for Organization.
  logo: `${SITE_URL}/apple-icon`,
  sameAs: ["https://github.com/Cyphra-dev", LINKS.npm],
  language: "en",
} as const;

/** Absolute URL for a site path ("/schema" → "https://www.cyphra.dev/schema"). */
export function absoluteUrl(path = "/"): string {
  if (/^https?:\/\//.test(path)) return path;
  return path === "/" || path === ""
    ? SITE.url
    : `${SITE.url}${path.startsWith("/") ? "" : "/"}${path}`;
}
