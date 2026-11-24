// One team with two members.
CREATE (:Team {id: "t1", name: "Core"});
CREATE (:Member {id: "m1", age: 30}), (:Member {id: "m2", age: 40});
MATCH (t:Team {id: "t1"}), (m:Member) CREATE (t)-[:HAS_MEMBER]->(m);
