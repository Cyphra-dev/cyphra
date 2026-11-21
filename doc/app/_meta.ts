import type { MetaRecord } from "nextra";

// Marketing pages (landing, pricing): full width, no docs chrome.
const FULL_PAGE = {
  type: "page",
  display: "hidden",
  theme: {
    layout: "full",
    sidebar: false,
    toc: false,
    breadcrumb: false,
    pagination: false,
    timestamp: false,
    copyPage: false,
  },
} as const;

// Blog and glossary (Markdown under content/): no sidebar; the index pages are full width and each
// post or term gets an on-page TOC (see content/*/_meta.ts).
const CONTENT_SECTION = {
  sidebar: false,
  breadcrumb: false,
  pagination: false,
  timestamp: false,
  copyPage: false,
} as const;

// Sidebar order and labels. `index` is the landing page.
const meta: MetaRecord = {
  index: FULL_PAGE,
  docs: { type: "page", title: "Docs", href: "/getting-started" },
  guides: { type: "page", title: "Guides" },
  // Cypher how-tos: linked from Guides (sidebar, index) and the footer, not the navbar.
  cypher: { type: "page", title: "Cypher how-tos", display: "hidden" },
  "cloud-nav": { type: "page", title: "Cloud", href: "/cloud" },
  pricing: { ...FULL_PAGE, display: "normal", title: "Pricing" },
  blog: { type: "page", title: "Blog", theme: CONTENT_SECTION },
  glossary: { type: "page", title: "Glossary", display: "hidden", theme: CONTENT_SECTION },
  "neo4j-orm": { type: "page", title: "Neo4j ORM", display: "hidden", theme: CONTENT_SECTION },
  compare: { type: "page", title: "Compare", display: "hidden", theme: CONTENT_SECTION },
  operator: { type: "page", title: "Operator", href: "https://github.com/Cyphra-dev/operator" },
  "--start": { type: "separator", title: "Start here" },
  "getting-started": "Getting started",
  example: "Example app",
  "--core": { type: "separator", title: "Core" },
  schema: "Schema",
  client: "Typed client",
  migrations: "Migrations",
  cli: "CLI",
  "--integrations": { type: "separator", title: "Integrations" },
  "better-auth": "Better Auth",
  "--lower": { type: "separator", title: "Lower-level APIs" },
  queries: "Query builder",
  runtime: "Runtime",
  "--cloud": { type: "separator", title: "Managed hosting" },
  cloud: "Cyphra Cloud",
};

export default meta;
