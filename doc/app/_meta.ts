import type { MetaRecord } from "nextra";

// Sidebar order and labels. `index` is the marketing landing page: full width, no docs chrome.
const meta: MetaRecord = {
  index: {
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
  },
  docs: { type: "page", title: "Docs", href: "/getting-started" },
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
};

export default meta;
