// The /cypher index as a CollectionPage (rendered by app/cypher/page.mdx).
export const CYPHER_COLLECTION = {
  path: "/cypher",
  name: "Cypher how-tos for Neo4j and TypeScript",
  description:
    "Answers to common Neo4j Cypher questions, each with the plain Cypher first and the typed Cyphra equivalent.",
  items: [
    { name: "Upsert with MERGE, ON CREATE and ON MATCH", path: "/cypher/upsert-merge" },
    { name: "MERGE vs CREATE", path: "/cypher/merge-vs-create" },
    { name: "Create a relationship between existing nodes", path: "/cypher/create-relationship" },
    { name: "Delete a node and its relationships", path: "/cypher/delete-node" },
    { name: "Pagination: SKIP/LIMIT vs keyset", path: "/cypher/pagination" },
    { name: "Count relationships and aggregate", path: "/cypher/count-relationships" },
    { name: "Unique constraints", path: "/cypher/unique-constraint" },
    { name: "Parameters and Cypher injection", path: "/cypher/parameters" },
  ],
};
