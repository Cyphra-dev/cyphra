CREATE (:Author {name: "Jane Austen"});
MATCH (a:Author {name: "Jane Austen"}) DELETE a;
MATCH (a:Author {name: "Frank Herbert"}) DELETE a;
MATCH (b:Book) DELETE b;
