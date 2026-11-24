// Two movies with actors (edge properties), reviews and a studio.
CREATE (:Movie {id: "m1", title: "Alpha", secretNote: "hidden", internalScore: 5, rating: 7, budget: 100.5, tagline: "first one", released: 2000, createdBy: "seed", plain: "p1"});
CREATE (:Movie {id: "m2", title: "Beta", secretNote: "also hidden", internalScore: 9, rating: 4, budget: 20.0, tagline: "second", released: 2010, createdBy: "seed", plain: "p2"});
CREATE (:Actor {name: "Keanu", age: 50}), (:Actor {name: "Carrie", age: 40});
MATCH (a:Actor {name: "Keanu"}), (m:Movie {id: "m1"}) CREATE (a)-[:ACTED_IN {role: "Neo", screenTime: 120, year: 1999}]->(m);
MATCH (a:Actor {name: "Keanu"}), (m:Movie {id: "m2"}) CREATE (a)-[:ACTED_IN {role: "John", screenTime: 90, year: 2014}]->(m);
MATCH (a:Actor {name: "Carrie"}), (m:Movie {id: "m1"}) CREATE (a)-[:ACTED_IN {role: "Trinity", screenTime: 80, year: 1999}]->(m);
CREATE (:Review {score: 5, text: "great"}), (:Review {score: 3, text: "fine"}), (:Review {score: 4, text: "good"});
MATCH (r:Review), (m:Movie {id: "m1"}) WHERE r.score IN [5, 3] CREATE (r)-[:REVIEWED]->(m);
MATCH (r:Review {score: 4}), (m:Movie {id: "m2"}) CREATE (r)-[:REVIEWED]->(m);
CREATE (:Studio {name: "Studio One"});
MATCH (s:Studio), (m:Movie {id: "m1"}) CREATE (s)-[:MADE]->(m);
CREATE (:Counter {hits: 3});
