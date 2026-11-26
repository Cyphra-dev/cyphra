CREATE (a:Person {id: "a", firstName: "Ada", lastName: "Lovelace", email: "ada@x.io"}),
  (b:Person {id: "b", firstName: "Bob", lastName: "Byte", email: "bob@x.io"}),
  (c:Person {id: "c", firstName: "Cy", lastName: "Cole", email: "cy@x.io"}),
  (b)-[:FOLLOWS {since: datetime("2026-01-01T00:00:00Z")}]->(a),
  (c)-[:FOLLOWS {since: datetime("2026-06-01T00:00:00Z")}]->(a),
  (a)-[:FOLLOWS {since: datetime("2026-03-01T00:00:00Z")}]->(b),
  (a)-[:WROTE]->(:Post {id: "p1", title: "Engines", published: true}),
  (a)-[:WROTE]->(:Post {id: "p2", title: "Draft notes", published: false}),
  (b)-[:WROTE]->(:Post {id: "p3", title: "Bits", published: true});
