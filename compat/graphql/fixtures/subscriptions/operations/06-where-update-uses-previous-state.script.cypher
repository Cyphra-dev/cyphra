// Filters of update events apply to the previous state.
MATCH (m:Movie {id: "m1"}) SET m.title = "Reloaded";
MATCH (m:Movie {id: "m1"}) SET m.title = "The Matrix Revolutions";
MATCH (m:Movie {id: "m2"}) SET m.title = "Matrix-like";
MATCH (m:Movie {id: "m2"}) SET m.title = "Back to Amelie";
