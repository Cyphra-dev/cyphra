CREATE (:Movie {id: "a", title: "The Dark Knight", released: 2008, rating: 9.0});
CREATE (:Movie {id: "b", title: "The Room", released: 2003, rating: 3.6});
CREATE (:Movie {id: "c", title: "The Godfather", released: 1972, rating: 9.2});
CREATE (:Movie {id: "d", title: "Heat", released: 1995, rating: 8.3});
CREATE (:Movie {id: "e", title: "The Prestige", released: 2006, rating: 8.5});
// No released property: a filter on it does not match.
CREATE (:Movie {id: "f", title: "The Unknown", rating: 8.0});
