import { describe, expect, it } from "vitest";
import { GraphQLInterfaceType, printType, type GraphQLNamedType } from "graphql";
import { readTypeDefs } from "./model.js";
import { buildV7Schema } from "./sdl.js";
import { CypherContext, labelPredicate, nodePattern, property } from "./cypher/context.js";
import { WhereCompiler } from "./cypher/where.js";

const TYPE_DEFS = /* GraphQL */ `
  interface Activity {
    id: ID!
    title: String!
    minutes: Int
    tracks: [Track!]! @declareRelationship
  }
  type Lab implements Activity @node(labels: ["Lab", "Activity"]) {
    id: ID!
    title: String!
    minutes: Int
    tracks: [Track!]! @relationship(type: "CONTAINS", direction: IN, properties: "Contains")
  }
  type Article implements Activity @node(labels: ["Article", "Activity"]) {
    id: ID!
    title: String!
    minutes: Int @alias(property: "readingMinutes")
    tracks: [Track!]! @relationship(type: "CONTAINS", direction: IN, properties: "Contains")
  }
  type Track @node {
    id: ID!
    contains: [Activity!]! @relationship(type: "CONTAINS", direction: OUT, properties: "Contains")
  }
  type Contains @relationshipProperties {
    position: Int!
  }
`;

function printed(name: string): string {
  return printType(buildV7Schema(readTypeDefs(TYPE_DEFS)).getType(name) as GraphQLNamedType);
}

describe("compat.v7 interfaces", () => {
  it("reads implementations, label sets and per-implementation properties", () => {
    const model = readTypeDefs(TYPE_DEFS);
    const iface = model.interfaces.get("Activity")!;
    expect(iface.implementations).toEqual(["Lab", "Article"]);
    expect(iface.labelSets).toEqual([
      ["Lab", "Activity"],
      ["Article", "Activity"],
    ]);
    expect(iface.attributes.find((a) => a.name === "minutes")?.variants).toEqual([
      { labels: ["Lab", "Activity"], property: "minutes" },
      { labels: ["Article", "Activity"], property: "readingMinutes" },
    ]);
    expect(iface.relationships[0]).toMatchObject({ name: "tracks", uniform: true });
    expect(model.node("Lab").relationships[0]?.declaredBy).toBe("Activity");
  });

  it("generates the interface, its typename filter and the implementation-keyed create input", () => {
    const schema = buildV7Schema(readTypeDefs(TYPE_DEFS));
    expect(schema.getType("Activity")).toBeInstanceOf(GraphQLInterfaceType);
    expect(printed("ActivityImplementation")).toBe(
      "enum ActivityImplementation {\n  Article\n  Lab\n}",
    );
    expect(printed("ActivityWhere")).toContain("typename: [ActivityImplementation!]");
    expect(printed("ActivityCreateInput")).toBe(
      "input ActivityCreateInput {\n  Lab: LabCreateInput\n  Article: ArticleCreateInput\n}",
    );
    expect(printed("ActivityTracksEdgeWhere")).toContain("Contains: ContainsWhere");
    expect(printed("Lab")).toContain("tracksConnection(");
    expect(printed("Lab")).toContain("): ActivityTracksConnection!");
    expect(schema.getQueryType()?.getFields().activitiesConnection).toBeDefined();
  });

  it("matches nodes of an interface by the labels of its implementations", () => {
    const iface = readTypeDefs(TYPE_DEFS).node("Activity");
    expect(nodePattern("n", iface)).toBe(
      "(n WHERE (n:`Lab`:`Activity` OR n:`Article`:`Activity`))",
    );
    expect(labelPredicate("n", readTypeDefs(TYPE_DEFS).node("Lab"))).toBe("n:`Lab`:`Activity`");
    expect(
      property(
        "n",
        iface.attributes.find((a) => a.name === "minutes")!,
      ),
    ).toBe(
      "CASE WHEN n:`Lab`:`Activity` THEN n.`minutes` WHEN n:`Article`:`Activity` THEN n.`readingMinutes` END",
    );
  });

  it("compiles typename filters and keyed edge filters", () => {
    const model = readTypeDefs(TYPE_DEFS);
    const ctx = new CypherContext();
    const where = new WhereCompiler(model, ctx);
    expect(where.node("n", model.node("Activity"), { typename: ["Article"] })).toBe(
      "n:`Article`:`Activity`",
    );
    expect(where.node("n", model.node("Activity"), { typename: [] })).toBeUndefined();
    const pred = where.node("n", model.node("Lab"), {
      tracksConnection: { some: { edge: { Contains: { position: { eq: 1 } } } } },
    });
    expect(pred).toContain(".`position` = $p0");
  });

  it("rejects implementations missing a declared relationship, like v7", () => {
    const labTracks =
      'tracks: [Track!]! @relationship(type: "CONTAINS", direction: IN, properties: "Contains")\n  }\n  type Article';
    expect(TYPE_DEFS).toContain(labTracks);
    expect(() => readTypeDefs(TYPE_DEFS.replace(labTracks, "}\n  type Article"))).toThrow(
      /declared as a relationship but the `@relationship` directive is missing/,
    );
  });
});
