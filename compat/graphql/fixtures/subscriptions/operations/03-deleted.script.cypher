MATCH (m:Movie {id: "m2"}) DELETE m;
MATCH (m:Movie {id: "m1"}) DETACH DELETE m;
MATCH (s:Studio) DELETE s;
