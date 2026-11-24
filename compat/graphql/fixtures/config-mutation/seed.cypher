// Two users, posts and tags with fixed ids.
CREATE (:User {id: "u1", name: "Ada"}), (:User {id: "u2", name: "Bob"});
CREATE (:Post {id: "p1", title: "Hello"}), (:Post {id: "p2", title: "World"});
MATCH (u:User {id: "u1"}), (p:Post) WHERE p.id IN ["p1", "p2"] CREATE (u)-[:WROTE]->(p);
CREATE (:Tag {name: "graph"}), (:Tag {name: "neo4j"});
MATCH (p:Post {id: "p1"}), (t:Tag {name: "graph"}) CREATE (p)-[:TAGGED]->(t);
CREATE (:Comment {id: "c1", text: "First"});
