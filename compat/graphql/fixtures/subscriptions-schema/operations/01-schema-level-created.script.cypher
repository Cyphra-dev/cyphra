CREATE (:Book {title: "Emma", pages: 474});
CREATE (:Book {title: "War and Peace", pages: 1225});
MATCH (b:Book {title: "Dune"}) SET b.pages = 413;
CREATE (:Author {name: "Jane Austen"});
