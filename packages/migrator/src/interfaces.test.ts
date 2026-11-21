import { parseSchema, resolveSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { EMPTY_SCHEMA_MODEL, ddlObjectsFromModel, diffSchemaModels } from "./diff.js";
import {
  constraintStatementsFromSchema,
  fulltextIndexStatementsFromSchema,
  indexStatementsFromSchema,
  vectorIndexStatementsFromSchema,
} from "./push.js";

const SRC = `
  interface Person {
    id        String     @id @default(cuid())
    email     String     @unique
    name      String     @index
    embedding Vector(3)? @vectorIndex
    a         Int?
    b         Int?

    @@unique([a, b])
    @@fulltext([name])
  }
  node Employee implements Person {
    badge String @unique
  }
  node Customer implements Person {
    tier String
  }
`;
const model = (src: string) => resolveSchema(parseSchema(src));

describe("DDL with interfaces", () => {
  it("creates constraints and indexes once, on the declaring label", () => {
    const objects = ddlObjectsFromModel(model(SRC));
    expect(objects.map((o) => o.name).sort()).toEqual(
      [
        "Employee_badge_unique",
        "Person_a_b_unique",
        "Person_email_unique",
        "Person_embedding_vector",
        "Person_id_id",
        "Person_name_fulltext",
        "Person_name_idx",
      ].sort(),
    );
    expect(objects.find((o) => o.name === "Person_email_unique")?.create).toContain(
      "FOR (n:`Person`)",
    );
  });

  it("matches cyphra push", () => {
    const doc = parseSchema(SRC);
    const names = (stmts: string[]) => stmts.map((s) => /(?:CONSTRAINT|INDEX) (\S+)/.exec(s)![1]);
    const pushed = [
      ...constraintStatementsFromSchema(doc),
      ...indexStatementsFromSchema(doc),
      ...vectorIndexStatementsFromSchema(doc),
      ...fulltextIndexStatementsFromSchema(doc),
    ];
    expect(names(pushed).sort()).toEqual(
      ddlObjectsFromModel(resolveSchema(doc))
        .map((o) => o.name)
        .sort(),
    );
  });
});

describe("migrations with interfaces", () => {
  const before = model(`
    node Employee {
      id    String @id @default(cuid())
      email String @unique
      name  String
    }
    node Customer {
      id   String @id @default(cuid())
      name String
    }
  `);
  const after = model(`
    interface Person {
      id    String @id @default(cuid())
      email String @unique
      name  String
    }
    node Employee implements Person {}
    node Customer implements Person {}
  `);

  it("backfills the interface label before creating its constraints", () => {
    const plan = diffSchemaModels(before, after);
    const cypher = plan.steps.map((s) => ("cypher" in s ? s.cypher : s.countCypher));
    const label = cypher.indexOf("MATCH (n:`Employee`) WHERE NOT n:`Person` SET n:`Person`");
    expect(label).toBeGreaterThan(-1);
    expect(cypher).toContain("MATCH (n:`Customer`) WHERE NOT n:`Person` SET n:`Person`");
    const drop = cypher.indexOf("DROP CONSTRAINT Employee_email_unique IF EXISTS");
    const create = cypher.findIndex((c) => c.startsWith("CREATE CONSTRAINT Person_email_unique"));
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(label);
    expect(create).toBeGreaterThan(label);
    // Customer gains a required email: guarded on its own label.
    expect(cypher).toContain(
      "MATCH (n:`Customer`) WHERE n.`email` IS NULL RETURN count(n) AS count",
    );
  });

  it("removes the label when a node stops implementing an interface, and never deletes nodes", () => {
    const plan = diffSchemaModels(after, before);
    const cypher = plan.steps.map((s) => ("cypher" in s ? s.cypher : s.countCypher));
    expect(cypher).toContain("MATCH (n:`Employee`) WHERE n:`Person` REMOVE n:`Person`");
    expect(cypher).toContain("MATCH (n:`Customer`) WHERE n:`Person` REMOVE n:`Person`");
    expect(cypher.some((c) => c.includes("DETACH DELETE"))).toBe(false);
  });

  it("migrates a new interface field once, on the interface label", () => {
    const v2 = model(`
      interface Person {
        id    String @id @default(cuid())
        email String @unique
        name  String
        role  String @default("member")
      }
      node Employee implements Person {}
      node Customer implements Person {}
    `);
    const plan = diffSchemaModels(after, v2);
    expect(plan.steps.map((s) => s.comment)).toEqual([
      "Backfill Person.role with its default on existing nodes.",
    ]);
  });

  it("plans a first migration with interfaces", () => {
    const plan = diffSchemaModels(EMPTY_SCHEMA_MODEL, after);
    expect(plan.steps.every((s) => s.kind === "statement" && s.cypher.startsWith("CREATE"))).toBe(
      true,
    );
  });
});
