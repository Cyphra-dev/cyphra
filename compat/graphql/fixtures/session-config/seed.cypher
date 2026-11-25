// Two things in the default database. Operations pick the database of their statements with
// context.sessionConfig (#251).
CREATE (:Thing {id: "t1", name: "Anvil"});
CREATE (:Thing {id: "t2", name: "Bolt"});
