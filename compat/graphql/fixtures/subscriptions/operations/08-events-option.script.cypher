// @subscription(events: [CREATED, DELETED]): no actorUpdated, deletes are still published.
MATCH (a:Actor) SET a.name = "Keanu";
MATCH (a:Actor) DETACH DELETE a;
