// Users following each other, posts with tags. The email constraint makes duplicates fail.
CREATE CONSTRAINT user_email FOR (n:User) REQUIRE n.email IS UNIQUE;
CREATE (alice:User {id: "u-alice", email: "alice@acme.io", name: "Alice", loginCount: 3, role: "ADMIN"})
CREATE (bob:User {id: "u-bob", email: "bob@acme.io", name: "Bob", loginCount: 0, role: "MEMBER"})
CREATE (carol:User {id: "u-carol", email: "carol@acme.io", name: "Carol", loginCount: 1, role: "MEMBER"})
CREATE (graphs:Post {id: "p-graphs", title: "Graphs", views: 10, published: true})
CREATE (cypher:Post {id: "p-cypher", title: "Cypher", views: 3, published: false})
CREATE (db:Tag {name: "db"})
CREATE (api:Tag {name: "api"})
CREATE (alice)-[:AUTHORED]->(graphs)
CREATE (alice)-[:AUTHORED]->(cypher)
CREATE (graphs)-[:TAGGED]->(db)
CREATE (alice)-[:FOLLOWS {since: datetime("2024-01-01T00:00:00Z"), weight: 1}]->(carol)
CREATE (carol)-[:FOLLOWS {since: datetime("2024-06-01T00:00:00Z"), weight: 0}]->(alice);
