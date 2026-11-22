// Schema-level @subscription: every type gets the CREATED event unless it sets its own events.
CREATE (:Book {title: "Dune", pages: 412});
CREATE (:Author {name: "Frank Herbert"});
