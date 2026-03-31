/* Nextra sidebar order and labels (Prisma-style IA).
 * Page folder names must match `../lib/sitemap-paths.ts` (SITEMAP_DOC_SEGMENTS). */
const meta = {
  index: "Home",
  introduction: "What is Cyphra?",
  "---sep-start": { type: "separator", title: "Get started" },
  "getting-started": "Getting started",
  configuration: "Configuration",
  providers: "Graph providers",
  "supported-databases": "Supported databases",
  "---sep-use": { type: "separator", title: "Using Cyphra" },
  schema: "Schema",
  introspection: "Introspection",
  queries: "Queries",
  "cypher-coverage": "Cypher coverage",
  "graph-orm": "Graph ORM",
  runtime: "Cyphra Client",
  migrations: "Migrations & push",
  cli: "CLI reference",
  production: "Production",
  governance: "Governance",
  "---sep-more": { type: "separator", title: "More" },
  example: "Example project",
};

export default meta;
