CREATE (w:Writer {handle: "ada", name: "Ada"})
CREATE (a:Article:Content {id: "a1", title: "Graphs", words: 900})
CREATE (:Video:Content {id: "v1", title: "Cypher in 5 minutes", seconds: 300})
CREATE (w)-[:WROTE]->(a);
