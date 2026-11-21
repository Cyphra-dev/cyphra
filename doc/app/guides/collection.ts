// The /guides index as a CollectionPage (rendered by app/guides/page.mdx).
export const GUIDES_COLLECTION = {
  path: "/guides",
  name: "Neo4j guides for TypeScript frameworks",
  description:
    "Use Neo4j from Next.js, NestJS, Bun and tRPC with Cyphra, deploy on Vercel, build GraphRAG retrieval, and migrate from @neo4j/graphql or Prisma.",
  items: [
    { name: "Neo4j with Next.js", path: "/guides/nextjs" },
    { name: "Deploy a Neo4j app on Vercel", path: "/guides/vercel" },
    { name: "Neo4j with NestJS", path: "/guides/nestjs" },
    { name: "Neo4j with Bun", path: "/guides/bun" },
    { name: "tRPC with Neo4j and zod", path: "/guides/trpc" },
    { name: "GraphRAG with Neo4j and TypeScript", path: "/guides/graphrag" },
    { name: "Migrate from @neo4j/graphql to Cyphra", path: "/guides/migrate-from-neo4j-graphql" },
    { name: "Migrate from Prisma and PostgreSQL to Neo4j", path: "/guides/migrate-from-prisma" },
    { name: "Cypher how-tos", path: "/cypher" },
  ],
};
