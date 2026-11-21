// The /guides index as a CollectionPage (rendered by app/guides/page.mdx).
export const GUIDES_COLLECTION = {
  path: "/guides",
  name: "Neo4j guides for TypeScript frameworks",
  description:
    "Use Neo4j from Next.js, NestJS and Bun with Cyphra's typed client, deploy a Neo4j-backed app on Vercel, and build GraphRAG retrieval.",
  items: [
    { name: "Neo4j with Next.js", path: "/guides/nextjs" },
    { name: "Deploy a Neo4j app on Vercel", path: "/guides/vercel" },
    { name: "Neo4j with NestJS", path: "/guides/nestjs" },
    { name: "Neo4j with Bun", path: "/guides/bun" },
    { name: "GraphRAG with Neo4j and TypeScript", path: "/guides/graphrag" },
    { name: "Cypher how-tos", path: "/cypher" },
  ],
};
