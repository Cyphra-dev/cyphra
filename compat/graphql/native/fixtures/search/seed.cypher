CREATE FULLTEXT INDEX articleText FOR (n:Article) ON EACH [n.title, n.body];
CREATE FULLTEXT INDEX authorText FOR (n:Author) ON EACH [n.name, n.bio];
CREATE VECTOR INDEX articleEmbedding FOR (n:Article) ON n.embedding OPTIONS { indexConfig: { `vector.dimensions`: 3, `vector.similarity_function`: 'cosine', `vector.quantization.enabled`: false } };
CREATE (ada:Author {id: "au-ada", name: "Ada Graph", bio: "Writes about graph databases"}),
  (bob:Author {id: "au-bob", name: "Bob", bio: "Writes about cooking"}),
  (a1:Article {id: "a1", title: "Graph databases", body: "Nodes and relationships in a graph", published: true, embedding: [1.0, 0.0, 0.0]}),
  (a2:Article {id: "a2", title: "Cypher queries", body: "Match patterns in the graph", published: true, embedding: [0.9, 0.1, 0.0]}),
  (a3:Article {id: "a3", title: "Secret graph roadmap", body: "Unreleased graph graph graph plans", published: false, embedding: [1.0, 0.0, 0.01]}),
  (a4:Article {id: "a4", title: "Bread", body: "Flour, water, salt", published: true, embedding: [0.0, 0.0, 1.0]}),
  (ada)-[:WROTE]->(a1), (ada)-[:WROTE]->(a2), (ada)-[:WROTE]->(a3), (bob)-[:WROTE]->(a4);
CALL db.awaitIndexes(60);
