MATCH (p:Post {id: "p-hello"}) SET p.title = "Hello again", p.views = 10;
MATCH (p:Post {id: "p-draft"}) SET p.title = "Draft v2";
