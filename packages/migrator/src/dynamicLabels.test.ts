import { parseSchema, resolveSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { ddlObjectsFromModel, diffSchemaModels } from "./diff.js";

const model = (src: string) => resolveSchema(parseSchema(src));
const BEFORE = model(`
  interface Content {
    id String @id
    @@labels([Archived])
  }
  node Post implements Content {
    title String
    @@labels([Featured, Pinned])
  }
`);

describe("migrations: dynamic labels", () => {
  it("creates no DDL for dynamic labels", () => {
    const plain = model(`
      interface Content { id String @id }
      node Post implements Content { title String }
    `);
    expect(ddlObjectsFromModel(BEFORE)).toEqual(ddlObjectsFromModel(plain));
  });

  it("notes added labels and offers to remove dropped ones from existing nodes", () => {
    const after = model(`
      interface Content {
        id String @id
        @@labels([Archived, Hidden])
      }
      node Post implements Content {
        title String
        @@labels([Featured])
      }
    `);
    const plan = diffSchemaModels(BEFORE, after);
    expect(plan.steps).toEqual([
      {
        kind: "destructive",
        comment:
          "Post no longer declares the dynamic label Pinned. Uncomment to remove :Pinned from existing Post nodes.",
        cypher: "MATCH (n:`Post`) WHERE n:`Pinned` REMOVE n:`Pinned`",
      },
    ]);
    expect(plan.notes).toEqual([
      "Content: dynamic label :Hidden declared (no migration step: no DDL is created for dynamic labels, and existing nodes get them when written).",
      "Post: dynamic label :Hidden declared (no migration step: no DDL is created for dynamic labels, and existing nodes get them when written).",
    ]);
  });

  it("keeps a dynamic label that becomes an interface of the node", () => {
    const after = model(`
      interface Content { id String @id }
      interface Pinned {}
      node Post implements Content, Pinned {
        title String
        @@labels([Featured, Archived])
      }
    `);
    const plan = diffSchemaModels(BEFORE, after);
    expect(plan.steps.map((s) => s.kind === "destructive" && s.cypher)).toEqual([false]);
    expect(plan.steps[0]).toMatchObject({
      cypher: "MATCH (n:`Post`) WHERE NOT n:`Pinned` SET n:`Pinned`",
    });
  });
});
