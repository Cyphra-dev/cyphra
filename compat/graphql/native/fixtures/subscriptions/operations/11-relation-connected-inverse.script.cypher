MATCH (a:User {id: "u-alice"}), (b:User {id: "u-bob"}) CREATE (a)-[:FOLLOWS {since: 2024}]->(b);
MATCH (a:User {id: "u-alice"}), (b:User {id: "u-bob"}) CREATE (b)-[:FOLLOWS {since: 2025}]->(a);
