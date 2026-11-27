MATCH (p:Post {id: "p-draft"}) DETACH DELETE p;
MATCH (p:Post {id: "p-hello"}) DETACH DELETE p;
CREATE (:Post {id: "p-new", title: "New", published: true, views: 0});
