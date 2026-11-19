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

// Sidebar order and labels. `index` is the landing page.
const meta: MetaRecord = {
  index: FULL_PAGE,
  docs: { type: "page", title: "Docs", href: "/getting-started" },
  "cloud-nav": { type: "page", title: "Cloud", href: "/cloud" },
  pricing: { ...FULL_PAGE, display: "normal", title: "Pricing" },
  operator: { type: "page", title: "Operator", href: "https://github.com/Cyphra-dev/operator" },
  "--start": { type: "separator", title: "Start here" },
  "getting-started": "Getting started",
  example: "Example app",
  "--core": { type: "separator", title: "Core" },
  schema: "Schema",
  client: "Typed client",
  migrations: "Migrations",
  cli: "CLI",
  "--lower": { type: "separator", title: "Lower-level APIs" },
  queries: "Query builder",
  runtime: "Runtime",
  "--cloud": { type: "separator", title: "Managed hosting" },
  cloud: "Cyphra Cloud",
};

export default meta;
