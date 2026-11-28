// The /compare index as a CollectionPage (rendered by app/compare/page.mdx).
export const COMPARE_COLLECTION = {
  path: "/compare",
  name: "Neo4j libraries for TypeScript, compared",
  description:
    "How Cyphra compares with Prisma, the Neo4j GraphQL Library, neogma, neode and the official neo4j-driver.",
  items: [
    { name: "Neo4j ORM? Cyphra is an OGM", path: "/neo4j-orm" },
    { name: "Cyphra vs the Neo4j GraphQL Library", path: "/compare/neo4j-graphql-library" },
    { name: "Cyphra vs neogma and neode", path: "/compare/neogma-neode" },
    { name: "Cyphra vs neo4j-driver", path: "/compare/neo4j-driver" },
  ],
};
