MATCH (:User {id: "u-bob"})-[f:FOLLOWS]->(:User {id: "u-alice"}) DELETE f;
