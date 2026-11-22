CREATE (:Movie {id: "m3", title: "Inception", released: 2010, rating: 8.8, tags: ["sci-fi"], genre: "ACTION", premiere: date("2010-07-16"), lastScreening: datetime("2021-05-04T18:30:00Z"), boxOffice: 9007199254740993, available: false});
CREATE (:Movie {id: "m4", title: "Untitled"});
// Not a Movie: no event on movieCreated.
CREATE (:Studio {name: "Pixar"});
CREATE (:Actor {name: "Tom Hardy"});
// Labels must be exactly the type's labels (v7 matches the label set).
CREATE (:Movie:Featured {id: "m5", title: "Extra label"});
// Several nodes in one transaction: one event each, in order.
CREATE (:Movie {id: "m6", title: "First"}), (:Movie {id: "m7", title: "Second"});
