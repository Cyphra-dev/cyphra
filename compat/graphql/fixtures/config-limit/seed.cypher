// One author with five volumes and four notes on the shelf; three tags.
CREATE FULLTEXT INDEX CfgLimitVolumeTitle IF NOT EXISTS FOR (n:Volume) ON EACH [n.title];
CALL db.awaitIndexes(30);
CREATE (:Author {id: "a1", name: "Ada"});
UNWIND range(1, 5) AS i CREATE (:Volume {id: "v" + i, title: "Graph volume " + i, pages: i * 100});
UNWIND range(1, 4) AS i CREATE (:Note {id: "n" + i});
UNWIND range(1, 3) AS i CREATE (:Tag {id: "t" + i});
MATCH (a:Author {id: "a1"}), (v:Volume) CREATE (a)-[:WROTE]->(v);
MATCH (a:Author {id: "a1"}), (v:Volume) WHERE v.id IN ["v1", "v2", "v3"] CREATE (a)-[:SHELVES]->(v);
MATCH (a:Author {id: "a1"}), (n:Note) CREATE (a)-[:SHELVES]->(n);
