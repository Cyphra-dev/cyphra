CREATE (:Post {id: "p-public", title: "Public", published: true, views: 0});
MATCH (b:User {id: "u-bob"}) CREATE (b)-[:AUTHORED]->(:Post {id: "p-bob-draft", title: "Bob draft", published: false, views: 0});
