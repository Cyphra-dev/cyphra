// Two accounts in one team.
CREATE (:Team {id: "t1", name: "Core"});
CREATE (:Account {id: "a1", email: "ada@example.test", role: "admin"});
CREATE (:Account {id: "a2", email: "bob@example.test", role: "member"});
MATCH (a:Account), (t:Team {id: "t1"}) CREATE (a)-[:MEMBER_OF]->(t);
