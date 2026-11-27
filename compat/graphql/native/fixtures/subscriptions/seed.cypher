CREATE (alice:User {id: "u-alice", name: "Alice"}),
  (bob:User {id: "u-bob", name: "Bob"}),
  (p1:Post {id: "p-hello", title: "Hello", published: true, views: 5}),
  (p2:Post {id: "p-draft", title: "Secret draft", published: false, views: 0}),
  (alice)-[:AUTHORED]->(p1), (alice)-[:AUTHORED]->(p2),
  (db:Tag {name: "db", internal: false}), (int:Tag {name: "internal", internal: true}),
  (bob)-[:FOLLOWS {since: 2020}]->(alice),
  (a1:Audit {id: "a-1", message: "login"});
