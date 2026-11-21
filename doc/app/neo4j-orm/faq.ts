// FAQ for /neo4j-orm. The page shows the same questions and answers, word for word (the SEO audit
// checks that every question and answer in the FAQPage JSON-LD is visible). Use ’ for apostrophes:
// the page renders typographic quotes.
export const NEO4J_ORM_FAQ = [
  [
    "Does Prisma support Neo4j?",
    "No. Prisma ORM supports relational databases and MongoDB, and Neo4j is not on its list of supported databases. The GitHub feature request for Neo4j support was closed as not planned in December 2024.",
  ],
  [
    "Is Cyphra a fork of Prisma?",
    "No. Cyphra is a separate open-source project under the MIT license. Its client follows Prisma’s naming (findMany, include, select, $transaction) so the patterns carry over, but the schema language, the code generator and the migration engine are written for Neo4j.",
  ],
  [
    "Which Neo4j versions does Cyphra need?",
    "The typed client needs Neo4j 5.6 or later, because it compiles relations to COLLECT and EXISTS subqueries. Relationship property uniqueness constraints need Neo4j 5.7 or later, traversals (traverse) need Neo4j 5.9 or later, vector indexes and findSimilar need Neo4j 5.15 or later (full-text indexes and search work on any Neo4j 5), and shortest paths (shortestPath, allShortestPaths) need Neo4j 5.21 or later.",
  ],
  [
    "Can I use Cyphra with an existing Neo4j database?",
    "Yes. cyphra pull reads labels, relationship types, property types, constraints and indexes from a live database and writes a .cyphra schema for you to review. cyphra generate then builds the typed client from it.",
  ],
  [
    "Can I still write Cypher?",
    "Yes. db.$cypher runs a parameterized tagged template and returns plain JavaScript values, and the query builder and the runtime under the client are exported from the same cyphra package.",
  ],
  [
    "Does Cyphra have down migrations?",
    "No. A Cyphra migration is a module with a single up function, and applied migrations are tracked in the database. To undo a change, generate or write a new migration.",
  ],
] as const;
