// One owner with secrets, reports and logs; standalone audits and drafts.
CREATE (:Owner {id: "o1", name: "Ada"});
CREATE (:Secret {id: "s1", value: "alpha"}), (:Secret {id: "s2", value: "beta"});
CREATE (:Report {id: "r1", pages: 10}), (:Report {id: "r2", pages: 30});
CREATE (:Log {id: "l1", level: 1}), (:Log {id: "l2", level: 3});
CREATE (:Audit {id: "a1", size: 5}), (:Audit {id: "a2", size: 7});
CREATE (:Draft {id: "d1", words: 100});
MATCH (o:Owner {id: "o1"}), (s:Secret) CREATE (o)-[:KEEPS]->(s);
MATCH (o:Owner {id: "o1"}), (r:Report) CREATE (o)-[:WROTE]->(r);
MATCH (o:Owner {id: "o1"}), (r:Report {id: "r1"}) CREATE (o)-[:HAS]->(r);
MATCH (o:Owner {id: "o1"}), (l:Log {id: "l2"}) CREATE (o)-[:HAS]->(l);
