import { createClient } from "./cyphra.gen.js";

const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env;
if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
  console.log("Set NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD to run this example.");
  process.exit(0);
}

const db = createClient({ uri: NEO4J_URI, user: NEO4J_USERNAME, password: NEO4J_PASSWORD });

try {
  await db.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;

  // Nested writes: create a user, their posts, and an edge with properties — in one transaction.
  await db.user.create({ data: { email: "bob@example.com", name: "Bob" } });
  const alice = await db.user.create({
    data: {
      email: "alice@example.com",
      name: "Alice",
      posts: {
        create: [
          { title: "Graphs are everywhere", tags: ["neo4j", "graphs"], published: true },
          { title: "Draft: Cypher tips", tags: ["cypher"] },
        ],
      },
      following: { connect: { email: "bob@example.com" } },
    },
    include: { posts: { orderBy: { title: "asc" } }, following: true },
  });

  // Fully typed: alice.posts is Post[], alice.following[0].$edge.since is a Date.
  console.log(`${alice.name} wrote ${alice.posts.length} posts`);
  console.log(
    `follows ${alice.following[0]?.name} since ${alice.following[0]?.$edge.since.toISOString()}`,
  );

  // Relation filters compile to Cypher EXISTS subqueries.
  const published = await db.post.findMany({
    where: { published: true, author: { is: { email: { endsWith: "@example.com" } } } },
    select: { title: true, author: { select: { name: true } } },
  });
  console.log("published:", published);

  await db.post.updateMany({ where: { tags: { has: "cypher" } }, data: { published: true } });
  console.log("published posts:", await db.post.count({ where: { published: true } }));
} finally {
  await db.$disconnect();
}
