// Rules require authentication by default: anonymous subscribers get no create event.
CREATE (:Review {author: "alice", body: "x", public: true});
