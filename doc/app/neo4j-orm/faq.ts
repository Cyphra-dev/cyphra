// FAQ for /neo4j-orm. The page shows the same questions and answers, word for word (the SEO audit
// checks that every question and answer in the FAQPage JSON-LD is visible). Use ’ for apostrophes:
// the page renders typographic quotes.
export const NEO4J_ORM_FAQ = [
  [
    "Is Cyphra an ORM?",
    "Strictly, no: Cyphra is an OGM (object-graph mapper). It maps nodes, labels and relationships rather than tables and rows, and it generates Cypher rather than SQL. Its client follows the ORM conventions TypeScript developers know (findMany, include, select, nested writes), so it fills the role people mean when they search for a Neo4j ORM.",
  ],
  [
    "What is the difference between an ORM and an OGM?",
    "An ORM maps relational tables, rows and foreign keys to objects and generates SQL. An OGM maps graph nodes, labels and relationships to objects and generates a graph query language such as Cypher. In a graph, relationships are records of their own, with a type, a direction and properties, so an OGM models them directly instead of through foreign keys and join tables.",
  ],
  [
    "Can I use Cyphra like Prisma?",
    "Yes, for the workflow: a schema file, cyphra generate for the typed client, and cyphra migrate dev, status and deploy for migrations. The client uses the same names as Prisma Client (findMany, include, select, orderBy, upsert, $transaction). It adds graph features Prisma has no equivalent for, such as typed edge properties, traverse and shortestPath, and cyphra import prisma converts an existing schema.prisma.",
  ],
  [
    "Does Cyphra work with Memgraph or FalkorDB?",
    "Yes. Set the memgraph dialect for Memgraph 3.x over Bolt, or pass the falkordb option for FalkorDB over the Redis protocol. CI runs the client, migration and CLI suites against both. A feature a database has no equivalent for throws an UnsupportedFeatureError before anything runs: interactive transactions, for example, are not available on FalkorDB.",
  ],
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
