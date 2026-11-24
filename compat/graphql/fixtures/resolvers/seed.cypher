// Labs written by users; progress is computed by resolvers.ts from context.jwt.
CREATE (ada:User {id: "u-ada", name: "Ada"})
CREATE (bob:User {id: "u-bob", name: "Bob"})
CREATE (l1:Lab {id: "l1", title: "Graphs 101", level: "BEGINNER"})
CREATE (l2:Lab {id: "l2", title: "Cypher deep dive", level: "ADVANCED"})
CREATE (l3:Lab {id: "l3", title: "Indexes", level: "ADVANCED"})
CREATE (ada)-[:WROTE]->(l1)
CREATE (bob)-[:WROTE]->(l1)
CREATE (bob)-[:WROTE]->(l2);
