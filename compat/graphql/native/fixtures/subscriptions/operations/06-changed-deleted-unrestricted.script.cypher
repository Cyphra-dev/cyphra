CREATE (:User {id: "u-carol", name: "Carol"});
MATCH (u:User {id: "u-alice"}) SET u.name = "Alice B.";
MATCH (u:User {id: "u-bob"}) DETACH DELETE u;
