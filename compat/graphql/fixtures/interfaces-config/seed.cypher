// Images and documents carry the shared Asset label, sounds only their own label.
CREATE (:Image:Asset {id: "img-1", name: "Logo", size: 120, secret: "s-img-1", label: "brand", tag: "red", width: 64});
CREATE (:Image:Asset {id: "img-2", name: "Banner", size: 900, label: "brand", tag: "blue", width: 1200});
CREATE (:Document:Asset {id: "doc-1", name: "Contract", size: 300, secret: "s-doc-1", pages: 12});
CREATE (:Document:Asset {id: "doc-2", name: "Notes", size: 40, pages: 2});
CREATE (:Sound {id: "snd-1", name: "Jingle", size: 500, tag: "red", seconds: 30});
CREATE (:Owner {id: "own-1", name: "Ada"}), (:Owner {id: "own-2", name: "Bob"});
CREATE (:Folder {id: "fold-1", name: "Marketing"}), (:Folder {id: "fold-2", name: "Legal"});
MATCH (o:Owner {id: "own-1"}), (a:Image {id: "img-1"}) CREATE (o)-[:OWNS {since: 2019}]->(a);
MATCH (o:Owner {id: "own-2"}), (a:Image {id: "img-2"}) CREATE (o)-[:OWNS {since: 2023}]->(a);
MATCH (o:Owner {id: "own-1"}), (a:Document {id: "doc-1"}) CREATE (o)-[:OWNS {role: "signer"}]->(a);
MATCH (o:Owner {id: "own-2"}), (a:Document {id: "doc-2"}) CREATE (o)-[:OWNS {role: "editor"}]->(a);
MATCH (o:Owner {id: "own-1"}), (a:Sound {id: "snd-1"}) CREATE (o)-[:OWNS]->(a);
MATCH (f:Folder {id: "fold-1"}), (a) WHERE a.id IN ["img-1", "img-2", "snd-1"] CREATE (a)-[:IN_FOLDER]->(f);
MATCH (f:Folder {id: "fold-2"}), (a) WHERE a.id IN ["doc-1", "doc-2"] CREATE (a)-[:IN_FOLDER]->(f);
MATCH (a {id: "img-1"}), (b {id: "doc-1"}) CREATE (a)-[:RELATED]->(b);
MATCH (a {id: "img-1"}), (b {id: "snd-1"}) CREATE (a)-[:RELATED]->(b);
MATCH (a {id: "doc-2"}), (b {id: "img-2"}) CREATE (a)-[:RELATED]->(b);
