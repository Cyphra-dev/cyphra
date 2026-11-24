// Two tracks containing labs, quizzes, videos and articles (CONTAINS edges carry the position).
// Every implementation has the shared LearningActivity label; the two decoys do not match any
// implementation (a LearningActivity without a type label, a Lab without the shared label).
CREATE (:Lab:LearningActivity {id: "lab-1", title: "Linux basics", durationMinutes: 30, image: "ubuntu:24.04"});
CREATE (:Lab:LearningActivity {id: "lab-2", title: "Docker networking", durationMinutes: 45, image: "alpine:3"});
CREATE (:Quiz:LearningActivity {id: "quiz-1", title: "Linux quiz", durationMinutes: 10, questions: 12});
CREATE (:Video:LearningActivity {id: "video-1", title: "Intro video", durationMinutes: 5, url: "https://example.test/v1", published: true});
CREATE (:Video:LearningActivity {id: "video-2", title: "Draft video", durationMinutes: 8, published: false});
CREATE (:Article:LearningActivity:Content {id: "article-1", title: "Reading list", readingMinutes: 20, body: "Read this"});
CREATE (:LearningActivity {id: "decoy-1", title: "Orphan activity", durationMinutes: 1});
CREATE (:Lab {id: "decoy-2", title: "Lab without the shared label", durationMinutes: 2});
CREATE (:Track {id: "track-1", name: "Linux"}), (:Track {id: "track-2", name: "Containers"}), (:Track {id: "track-3", name: "Empty"});
MATCH (t:Track {id: "track-1"}), (a {id: "lab-1"}) CREATE (t)-[:CONTAINS {position: 1}]->(a);
MATCH (t:Track {id: "track-1"}), (a {id: "quiz-1"}) CREATE (t)-[:CONTAINS {position: 2, optional: true}]->(a);
MATCH (t:Track {id: "track-1"}), (a {id: "video-1"}) CREATE (t)-[:CONTAINS {position: 3}]->(a);
MATCH (t:Track {id: "track-1"}), (a {id: "article-1"}) CREATE (t)-[:CONTAINS {position: 4, optional: true}]->(a);
MATCH (t:Track {id: "track-1"}), (a {id: "decoy-1"}) CREATE (t)-[:CONTAINS {position: 5}]->(a);
MATCH (t:Track {id: "track-2"}), (a {id: "lab-2"}) CREATE (t)-[:CONTAINS {position: 1}]->(a);
MATCH (t:Track {id: "track-2"}), (a {id: "video-2"}) CREATE (t)-[:CONTAINS {position: 2}]->(a);
MATCH (t:Track {id: "track-2"}), (a {id: "lab-1"}) CREATE (t)-[:CONTAINS {position: 3}]->(a);
MATCH (t:Track {id: "track-1"}), (a {id: "lab-1"}) CREATE (t)-[:FEATURES]->(a);
MATCH (t:Track {id: "track-2"}), (a {id: "video-2"}) CREATE (t)-[:FEATURES]->(a);
CREATE (:Author {id: "author-1", name: "Ada"}), (:Author {id: "author-2", name: "Bob"});
MATCH (u:Author {id: "author-1"}), (a) WHERE a.id IN ["lab-1", "quiz-1", "video-1"] CREATE (u)-[:WROTE]->(a);
MATCH (u:Author {id: "author-2"}), (a) WHERE a.id IN ["lab-2", "video-2"] CREATE (u)-[:WROTE]->(a);
MATCH (u:Author {id: "author-1"}), (a {id: "article-1"}) CREATE (u)-[:AUTHORED]->(a);
