import type { MetaRecord } from "nextra";

const meta: MetaRecord = {
  index: "Overview",
  "--frameworks": { type: "separator", title: "Frameworks" },
  nextjs: "Next.js",
  nestjs: "NestJS",
  bun: "Bun",
  "--deploy": { type: "separator", title: "Deploy" },
  vercel: "Vercel",
  "--ai": { type: "separator", title: "AI" },
  graphrag: "GraphRAG",
  "--migrate": { type: "separator", title: "Migrate" },
  "migrate-from-neo4j-graphql": "From @neo4j/graphql",
  "--cypher": { type: "separator", title: "Cypher" },
  "cypher-howtos": { title: "Cypher how-tos", href: "/cypher" },
};

export default meta;
