// Full-text indexes are created by the application (v7 does not create them); wait for them so the
// first query sees every node.
CREATE FULLTEXT INDEX BookTitle IF NOT EXISTS FOR (n:Book) ON EACH [n.title];
CREATE FULLTEXT INDEX BookText IF NOT EXISTS FOR (n:Book) ON EACH [n.title, n.summary];
CREATE (le:Author {name: "Ursula Le Guin", born: 1929}),
  (pr:Author {name: "Terry Pratchett", born: 1948}),
  (ga:Author {name: "Neil Gaiman", born: 1960}),
  (ja:Author {name: "Jane Doe"}),
  (b1:Book {isbn: "b1", title: "A Wizard of Earthsea", summary: "A young wizard and a shadow", year: 1968}),
  (b2:Book {isbn: "b2", title: "The Tombs of Atuan", summary: "A priestess in the dark tombs", year: 1971}),
  (b3:Book {isbn: "b3", title: "Good Omens", summary: "An angel, a demon and the end of the world", year: 1990}),
  (b4:Book {isbn: "b4", title: "The Colour of Magic", summary: "A wizard who cannot do magic", year: 1983}),
  (b5:Book {isbn: "b5", title: "American Gods", summary: "Old gods and new gods in America", year: 2001}),
  (b6:Book {isbn: "b6", title: "The Wizard Next Door", year: 2015}),
  (le)-[:WROTE {position: 1}]->(b1),
  (le)-[:WROTE {position: 1}]->(b2),
  (pr)-[:WROTE {position: 1}]->(b3),
  (ga)-[:WROTE {position: 2}]->(b3),
  (pr)-[:WROTE {position: 1}]->(b4),
  (ga)-[:WROTE {position: 1}]->(b5),
  (ja)-[:WROTE {position: 1}]->(b6),
  (:Review {rating: 5, by: "ana"})-[:REVIEWS]->(b1),
  (:Review {rating: 4, by: "bo"})-[:REVIEWS]->(b1),
  (:Review {rating: 3, by: "ana"})-[:REVIEWS]->(b3),
  (:Review {rating: 5, by: "bo"})-[:REVIEWS]->(b3),
  (:Review {rating: 4, by: "cleo"})-[:REVIEWS]->(b3),
  (:Review {rating: 2, by: "bo"})-[:REVIEWS]->(b4);
CALL db.awaitIndexes();
