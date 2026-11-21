// A social graph on neogma 2 (legacy experimental decorators): people follow each other, with
// properties on the edge, and like posts.
import { Node, NodeEntity, PrimaryKey, Property, Relationship } from "neogma/legacy";
import { Type, defineRelationshipProperties } from "neogma";
import type { Related } from "neogma";

@Node({ label: ["Person", "Account"] })
export class PersonNode extends NodeEntity {
  @PrimaryKey(Type.String())
  id!: string;

  @Property(Type.String({ minLength: 3, maxLength: 30, pattern: "^[a-z0-9_]+$" }))
  handle!: string;

  @Property(Type.Optional(Type.String({ maxLength: 280 })))
  bio?: string;

  @Property(Type.Array(Type.String(), { minItems: 0, maxItems: 5 }))
  interests!: string[];

  @Property(Type.Union([Type.Integer({ minimum: 13 }), Type.Null()]))
  age!: number | null;

  @Property()
  avatarUrl?: string;

  static readonly followProps = defineRelationshipProperties({
    since: Type.String({ format: "date-time" }),
    Muted: { property: "muted", schema: Type.Optional(Type.Boolean()) },
  });

  @Relationship({
    name: "FOLLOWS",
    direction: "out",
    model: "self",
    properties: () => PersonNode.followProps,
  })
  Following!: Related<typeof PersonNode, typeof PersonNode.followProps>;

  @Relationship({
    name: "FOLLOWS",
    direction: "in",
    model: "self",
    properties: () => PersonNode.followProps,
  })
  Followers!: Related<typeof PersonNode, typeof PersonNode.followProps>;

  @Relationship({ name: "FRIENDS_WITH", direction: "none", model: "self" })
  Friends!: Related<typeof PersonNode>;

  @Relationship({
    name: "LIKED",
    direction: "out",
    model: () => Post,
    properties: {
      at: Type.String({ format: "date-time" }),
      reaction: Type.Enum(["like", "love", "laugh"]),
    },
  })
  LikedPosts!: Related<typeof Post>;

  @Relationship({ name: "WROTE", direction: "out", model: () => Post })
  Posts!: Related<typeof Post>;
}

@Node()
export class Post extends NodeEntity {
  @PrimaryKey()
  id!: string;

  @Property(Type.String({ minLength: 1, maxLength: 5000 }))
  body!: string;

  @Property(Type.Integer({ exclusiveMinimum: 0 }))
  revision!: number;

  @Property(Type.Union([Type.String(), Type.Number()]))
  legacyScore!: string | number;

  @Relationship({ name: "WROTE", direction: "in", model: () => PersonNode })
  Author!: Related<typeof PersonNode>;

  @Relationship({
    name: "LIKED",
    direction: "in",
    model: () => PersonNode,
    properties: { at: Type.String({ format: "date-time" }) },
  })
  LikedBy!: Related<typeof PersonNode>;

  static beforeDelete(post: { id: string }): void {
    console.log(`deleting ${post.id}`);
  }
}
