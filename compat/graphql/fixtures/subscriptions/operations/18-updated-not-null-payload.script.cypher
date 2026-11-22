// A required field removed from the node: v7 returns the GraphQL error of the non-null field.
MATCH (m:Movie {id: "m2"}) REMOVE m.title;
MATCH (m:Movie {id: "m2"}) SET m.rating = 1.5;
