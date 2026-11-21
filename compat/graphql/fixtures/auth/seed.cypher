// Auth: users own documents (public or private), documents are tagged, tags belong to an org.
// Rules: see typeDefs.graphql (type, field and schema level; $jwt and $context references).
CREATE (ann:User {id: "u-ann", name: "Ann", nickname: "annie", phone: "555-0101", salary: 5000})
CREATE (ben:User {id: "u-ben", name: "Ben", nickname: "benny", phone: "555-0102", salary: 4000})
CREATE (d1:Document {id: "d-1", title: "Ann public", public: true})
CREATE (d2:Document {id: "d-2", title: "Ann private", public: false})
CREATE (d3:Document {id: "d-3", title: "Ben private", public: false})
CREATE (d4:Document {id: "d-4", title: "Orphan private", public: false})
CREATE (ann)-[:OWNS]->(d1)
CREATE (ann)-[:OWNS]->(d2)
CREATE (ben)-[:OWNS]->(d3)
CREATE (t1:Tag {name: "red", org: "acme"})
CREATE (t2:Tag {name: "blue", org: "globex"})
CREATE (d1)-[:TAGGED]->(t1)
CREATE (d2)-[:TAGGED]->(t1)
CREATE (d3)-[:TAGGED]->(t2);
