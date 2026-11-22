MATCH (m:Movie {id: "m1"}) SET m.title = "The Matrix Reloaded", m.released = 2003;
// Same value: v7 drops update events whose properties did not change.
MATCH (m:Movie {id: "m2"}) SET m.title = "Amelie";
MATCH (m:Movie {id: "m2"}) SET m.tags = ["romance"];
MATCH (m:Movie {id: "m2"}) REMOVE m.released;
// Relationship changes are not node updates.
MATCH (m:Movie {id: "m2"}), (a:Actor) CREATE (a)-[:ACTED_IN]->(m);
// A node created and updated in one transaction is one create event.
CREATE (m:Movie {id: "m3", title: "Draft"}) SET m.title = "Final";
MATCH (m:Movie {id: "m2"}) DETACH DELETE m;
