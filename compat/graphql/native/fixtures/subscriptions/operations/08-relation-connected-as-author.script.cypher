MATCH (p:Post {id: "p-hello"}), (t:Tag {name: "db"}) CREATE (p)-[:TAGGED]->(t);
MATCH (p:Post {id: "p-hello"}), (t:Tag {name: "internal"}) CREATE (p)-[:TAGGED]->(t);
MATCH (p:Post {id: "p-draft"}), (t:Tag {name: "db"}) CREATE (p)-[:TAGGED]->(t);
