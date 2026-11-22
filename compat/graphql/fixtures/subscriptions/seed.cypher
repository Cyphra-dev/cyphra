// Subscriptions fixture: CDC events (Neo4j Enterprise). Operations subscribe, then run their
// `.script.cypher`; the seed itself never produces events (the engine starts after it).
CREATE (:Movie {id: "m1", title: "The Matrix", released: 1999, rating: 8.7, tags: ["sci-fi", "action"], genre: "ACTION", premiere: date("1999-03-31"), lastScreening: datetime("2020-01-01T20:00:00Z"), boxOffice: 463517383, available: true});
CREATE (:Movie {id: "m2", title: "Amelie", released: 2001, rating: 8.3, genre: "COMEDY"});
MATCH (m:Movie {id: "m1"}) CREATE (:Actor {name: "Keanu Reeves"})-[:ACTED_IN {role: "Neo"}]->(m);
CREATE (:Review {author: "alice", body: "Great", public: false});
CREATE (:Review {author: "bob", body: "Meh", public: true});
CREATE (:Report {title: "Q1"});
CREATE (:Secret {code: "s1"});
CREATE (:Studio {name: "Warner"});
