// Alice wrote two posts (one with comments), Bob one; Bob follows Alice.
CREATE CONSTRAINT nw_user_email FOR (n:User) REQUIRE n.email IS UNIQUE;
CREATE CONSTRAINT nw_post_id FOR (n:Post) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT nw_tag_name FOR (n:Tag) REQUIRE n.name IS UNIQUE;
CREATE (alice:User {id: "u-alice", email: "alice@acme.io", name: "Alice"})
CREATE (bob:User {id: "u-bob", email: "bob@acme.io", name: "Bob"})
CREATE (carol:User {id: "u-carol", email: "carol@acme.io", name: "Carol"})
CREATE (profile:Profile {id: "pr-alice", bio: "Graphs all day"})
CREATE (graphs:Post {id: "p-graphs", title: "Graphs", views: 10, published: true})
CREATE (cypher:Post {id: "p-cypher", title: "Cypher", views: 3, published: false})
CREATE (bobs:Post {id: "p-bob", title: "Bob's post", views: 1, published: true})
CREATE (db:Tag {name: "db"})
CREATE (c1:Comment {id: "c-1", body: "Nice"})
CREATE (c2:Comment {id: "c-2", body: "More please"})
CREATE (alice)-[:AUTHORED]->(graphs)
CREATE (alice)-[:AUTHORED]->(cypher)
CREATE (bob)-[:AUTHORED]->(bobs)
CREATE (alice)-[:HAS_PROFILE]->(profile)
CREATE (graphs)-[:TAGGED]->(db)
CREATE (c1)-[:ON]->(cypher)
CREATE (c2)-[:ON]->(cypher)
CREATE (bob)-[:FOLLOWS {weight: 2}]->(alice);
