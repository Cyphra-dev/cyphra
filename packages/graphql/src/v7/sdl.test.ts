import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lexicographicSortSchema, printSchema, printType, type GraphQLNamedType } from "graphql";
import { describe, expect, it } from "vitest";
import { readTypeDefs, UnsupportedTypeDefsError } from "./model.js";
import { buildV7Schema } from "./sdl.js";

const COMPAT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../compat/graphql",
);

function schemaOf(typeDefs: string) {
  return buildV7Schema(readTypeDefs(typeDefs));
}

function printed(typeDefs: string, name: string): string {
  const t = lexicographicSortSchema(schemaOf(typeDefs)).getType(name);
  if (!t) throw new Error(`type ${name} not generated`);
  return printType(t as GraphQLNamedType);
}

const MOVIES = /* GraphQL */ `
  type Movie @node {
    id: ID! @id
    title: String!
    tagline: String
    released: Int
    genres: [String!]!
    actors: [Person!]! @relationship(type: "ACTED_IN", direction: IN, properties: "ActedIn")
  }
  type Person @node {
    name: String!
    born: Int
    movies: [Movie!]! @relationship(type: "ACTED_IN", direction: OUT, properties: "ActedIn")
  }
  type ActedIn @relationshipProperties {
    roles: [String!]!
    screenTime: Int
  }
`;

describe("SDL: printed schema is identical to @neo4j/graphql 7.6.8", () => {
  const fixtures = existsSync(path.join(COMPAT, "fixtures"))
    ? readdirSync(path.join(COMPAT, "fixtures"))
    : [];
  it("has the compatibility fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });
  for (const fixture of fixtures) {
    it(fixture, () => {
      const typeDefs = readFileSync(
        path.join(COMPAT, "fixtures", fixture, "typeDefs.graphql"),
        "utf8",
      );
      const golden = readFileSync(path.join(COMPAT, "golden", fixture, "schema.graphql"), "utf8");
      expect(`${printSchema(lexicographicSortSchema(schemaOf(typeDefs)))}\n`).toBe(golden);
    });
  }
});

describe("SDL pieces", () => {
  it("root fields: list and connection queries, plural names, no options argument", () => {
    const query = printed(MOVIES, "Query");
    expect(query).toContain(
      "movies(limit: Int, offset: Int, sort: [MovieSort!], where: MovieWhere): [Movie!]!",
    );
    expect(query).toContain(
      "peopleConnection(after: String, first: Int, sort: [PersonSort!], where: PersonWhere): PeopleConnection!",
    );
    expect(query).not.toContain("options");
  });

  it("where: generic filters plus deprecated field_OPERATOR fields; _IN follows nullability", () => {
    const where = printed(MOVIES, "MovieWhere");
    expect(where).toContain("title: StringScalarFilters");
    expect(where).toContain("title_IN: [String!] @deprecated");
    expect(where).toContain("tagline_IN: [String] @deprecated");
    expect(where).toContain("genres: StringListFilters");
    expect(where).toContain("genres_INCLUDES: String @deprecated");
    expect(where).toContain("actors: PersonRelationshipFilters");
    expect(where).toContain("actorsConnection: MovieActorsConnectionFilters");
    expect(where).toContain(
      `actors_SINGLE: PersonWhere @deprecated(reason: "Please use the relevant generic filter 'actors: {  single: ... }' instead.")`,
    );
  });

  it("sort: lists are not sortable on nodes, but are on relationship properties", () => {
    expect(printed(MOVIES, "MovieSort")).not.toContain("genres");
    expect(printed(MOVIES, "ActedInSort")).toContain("roles: SortDirection");
  });

  it("create / update inputs skip @id fields; edge create input is required when it has required fields", () => {
    const create = printed(MOVIES, "MovieCreateInput");
    expect(create).not.toContain("id:");
    expect(printed(MOVIES, "MovieActorsCreateFieldInput")).toContain("edge: ActedInCreateInput!");
    const update = printed(MOVIES, "MovieUpdateInput");
    expect(update).toContain("released: IntScalarMutations");
    expect(update).toContain("released_INCREMENT: Int @deprecated");
  });

  it("@timestamp and @default shape the create and update inputs", () => {
    const td = /* GraphQL */ `
      type Post @node {
        title: String!
        published: Boolean! @default(value: false)
        createdAt: DateTime! @timestamp(operations: [CREATE])
        updatedAt: DateTime @timestamp(operations: [UPDATE])
      }
    `;
    const create = printed(td, "PostCreateInput");
    expect(create).toContain("published: Boolean! = false");
    expect(create).not.toContain("createdAt");
    expect(create).toContain("updatedAt: DateTime");
    const update = printed(td, "PostUpdateInput");
    expect(update).toContain("createdAt: DateTimeScalarMutations");
    expect(update).not.toContain("updatedAt");
  });

  it("aggregate selections only cover aggregable scalars (no ID, Boolean, Date, enum, list)", () => {
    const td = /* GraphQL */ `
      type Thing @node {
        id: ID!
        name: String!
        flag: Boolean
        day: Date
        size: BigInt
        at: DateTime
        tags: [String!]!
      }
    `;
    const node = printed(td, "ThingAggregateNode");
    expect(node).toContain("name: StringAggregateSelection!");
    expect(node).toContain("size: BigIntAggregateSelection!");
    expect(node).toContain("at: DateTimeAggregateSelection!");
    for (const f of ["id:", "flag:", "day:", "tags:"]) expect(node).not.toContain(f);
  });

  it("relationship properties type lists the fields that use it", () => {
    expect(printed(MOVIES, "ActedIn")).toContain(
      '"""\nThe edge properties for the following fields:\n* Movie.actors\n* Person.movies\n"""',
    );
  });
});

describe("SDL: unions", () => {
  const UNIONS = /* GraphQL */ `
    union Content = Movie | Book
    type User @node {
      name: String!
      favorites: [Content!]! @relationship(type: "FAVORITED", direction: OUT, properties: "Fav")
      watchlist: [Content!]! @relationship(type: "WANTS", direction: OUT)
    }
    type Movie @node {
      title: String!
    }
    type Book @node {
      isbn: ID!
    }
    type Fav @relationshipProperties {
      rating: Int!
    }
  `;

  it("prints the root union query and member-keyed where", () => {
    const query = printed(UNIONS, "Query");
    expect(query).toContain("contents(limit: Int, offset: Int, where: ContentWhere): [Content!]!");
    expect(query).not.toContain("contentsConnection");
    expect(printed(UNIONS, "ContentWhere")).toBe(
      "input ContentWhere {\n  Book: BookWhere\n  Movie: MovieWhere\n}",
    );
  });

  it("relationship fields: no sort on the list, edge sort only with properties, no aggregate", () => {
    const user = printed(UNIONS, "User");
    expect(user).toContain("favorites(limit: Int, offset: Int, where: ContentWhere): [Content!]!");
    expect(user).toContain(
      "favoritesConnection(after: String, first: Int, sort: [UserFavoritesConnectionSort!], where: UserFavoritesConnectionWhere): UserFavoritesConnection!",
    );
    expect(user).toContain(
      "watchlistConnection(after: String, first: Int, where: UserWatchlistConnectionWhere): UserWatchlistConnection!",
    );
    expect(printed(UNIONS, "UserFavoritesConnection")).not.toContain("aggregate");
    expect(printed(UNIONS, "UserFavoritesConnectionSort")).toBe(
      "input UserFavoritesConnectionSort {\n  edge: FavSort\n}",
    );
    expect(printed(UNIONS, "UserWhere")).not.toContain("favoritesAggregate");
  });

  it("nested write inputs are keyed by member", () => {
    expect(printed(UNIONS, "UserFavoritesUpdateInput")).toBe(
      "input UserFavoritesUpdateInput {\n  Book: [UserFavoritesBookUpdateFieldInput!]\n  Movie: [UserFavoritesMovieUpdateFieldInput!]\n}",
    );
    expect(printed(UNIONS, "UserFavoritesCreateInput")).toBe(
      "input UserFavoritesCreateInput {\n  Book: UserFavoritesBookFieldInput\n  Movie: UserFavoritesMovieFieldInput\n}",
    );
    expect(printed(UNIONS, "UserFavoritesMovieConnectFieldInput")).toBe(
      "input UserFavoritesMovieConnectFieldInput {\n  edge: FavCreateInput!\n  where: MovieConnectWhere\n}",
    );
    expect(printed(UNIONS, "UserUpdateInput")).toContain("favorites: UserFavoritesUpdateInput\n");
  });
});

describe("SDL: to-one relationships (v7 7.6.8)", () => {
  const TO_ONE = /* GraphQL */ `
    type Lab @node {
      name: String!
      owner: User @relationship(type: "OWNS", direction: IN)
    }
    type User @node {
      name: String!
      labs: [Lab!]! @relationship(type: "OWNS", direction: OUT)
    }
  `;

  it("field and connection without arguments, connection without aggregate", () => {
    const lab = printed(TO_ONE, "Lab");
    expect(lab).toContain("  owner: User\n  ownerConnection: LabOwnerConnection!\n");
    expect(printed(TO_ONE, "LabOwnerConnection")).not.toContain("aggregate");
  });

  it("where takes the target filter and a connection filter", () => {
    const where = printed(TO_ONE, "LabWhere");
    expect(where).toContain("  owner: UserWhere\n  ownerConnection: LabOwnerConnectionWhere\n");
    expect(where).not.toContain("ownerAggregate");
    expect(where).not.toContain("owner_SOME");
  });

  it("writes: single create and delete inputs, no connect / disconnect / update", () => {
    expect(printed(TO_ONE, "LabOwnerFieldInput")).toBe(
      "input LabOwnerFieldInput {\n  create: LabOwnerCreateFieldInput\n}",
    );
    expect(printed(TO_ONE, "LabDeleteInput")).toBe(
      "input LabDeleteInput {\n  owner: LabOwnerDeleteFieldInput\n}",
    );
    expect(printed(TO_ONE, "LabUpdateInput")).not.toContain("owner");
    const schema = schemaOf(TO_ONE);
    expect(schema.getType("LabConnectInput")).toBeUndefined();
    expect(schema.getType("LabDisconnectInput")).toBeUndefined();
  });

  it("rejects a non-nullable to-one relationship, like v7", () => {
    expect(() => readTypeDefs(TO_ONE.replace("owner: User @", "owner: User! @"))).toThrow(
      /Non-list relationship property "owner" cannot have non-nullable type/,
    );
  });
});

describe("unsupported type definitions fail loudly", () => {
  it.each([
    ["interfaces", "interface Production { title: String! }"],
    ["unions of non-@node types", "type A @node { x: Int } enum E { X } union U = A | E"],
    [
      "@cypher fields returning unions",
      'type A @node { x: Int, u: [U!]! @cypher(statement: "RETURN 1 AS u", columnName: "u") } union U = A',
    ],
    ["Duration", "type A @node { d: Duration }"],
    ["unknown directives", 'type A @node { x: Int @populatedBy(callback: "f") }'],
    [
      "unions mixing @node types and other types",
      "type A @node { x: Int } type B { y: Int } union U = A | B",
    ],
    [
      "generated types in fields served by resolvers",
      "type A @node { x: Int } type Query { a(where: AWhere): Int }",
    ],
    ["directives on types without @node", 'type B @plural(value: "bs") { y: Int }'],
  ])("%s", (_name, typeDefs) => {
    expect(() => readTypeDefs(typeDefs)).toThrow(UnsupportedTypeDefsError);
  });
});

describe("cyphraSchema", () => {
  it("derives the Cyphra schema model from the same type definitions", async () => {
    const { cyphraSchema } = await import("./index.js");
    const { model, issues } = cyphraSchema(MOVIES);
    expect(model.nodes.map((n) => n.name)).toEqual(["Movie", "Person"]);
    expect(model.relationships.map((r) => r.relType)).toContain("ACTED_IN");
    expect(Array.isArray(issues)).toBe(true);
  });
});
