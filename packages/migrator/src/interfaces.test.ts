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

describe("migrations with interfaces extending interfaces", () => {
  const flat = model(`
    interface Person {
      id    String @id @default(cuid())
      email String @unique
    }
    node Employee implements Person {
      team String
    }
    node Contractor implements Person {
      team String
    }
    node Customer implements Person {}
  `);
  const nested = model(`
    interface Person {
      id    String @id @default(cuid())
      email String @unique
    }
    interface Staff extends Person {
      team String @index
    }
    node Employee implements Staff {}
    node Contractor implements Staff {}
    node Customer implements Person {}
  `);
  const cypherOf = (plan: ReturnType<typeof diffSchemaModels>) =>
    plan.steps.map((s) => ("cypher" in s ? s.cypher : s.countCypher));

  it("keeps inherited DDL on the declaring label", () => {
    expect(
      ddlObjectsFromModel(nested)
        .map((o) => o.name)
        .sort(),
    ).toEqual(["Person_email_unique", "Person_id_id", "Staff_team_idx"]);
  });

  it("backfills the new intermediate label before creating its DDL", () => {
    const cypher = cypherOf(diffSchemaModels(flat, nested));
    const employee = cypher.indexOf("MATCH (n:`Employee`) WHERE NOT n:`Staff` SET n:`Staff`");
    const contractor = cypher.indexOf("MATCH (n:`Contractor`) WHERE NOT n:`Staff` SET n:`Staff`");
    const create = cypher.findIndex((c) => c.startsWith("CREATE") && c.includes("Staff_team_idx"));
    expect(employee).toBeGreaterThan(-1);
    expect(contractor).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(Math.max(employee, contractor));
    // Person was implemented already: no second backfill, no step on the interface's own label.
    expect(cypher.filter((c) => c.includes("SET n:`Person`"))).toEqual([]);
    expect(cypher.some((c) => c.startsWith("MATCH (n:`Staff`)"))).toBe(false);
    // Nothing touches Customer, and Person's constraints stay.
    expect(cypher.some((c) => c.includes("Customer"))).toBe(false);
    expect(cypher.some((c) => c.includes("DROP") && c.includes("Person_"))).toBe(false);
  });

  it("removes the intermediate label when the nesting goes away", () => {
    const cypher = cypherOf(diffSchemaModels(nested, flat));
    expect(cypher).toContain("MATCH (n:`Employee`) WHERE n:`Staff` REMOVE n:`Staff`");
    expect(cypher).toContain("MATCH (n:`Contractor`) WHERE n:`Staff` REMOVE n:`Staff`");
    expect(cypher.some((c) => c.includes("REMOVE n:`Person`"))).toBe(false);
    expect(cypher.some((c) => c.includes("DETACH DELETE"))).toBe(false);
  });

  it("backfills every ancestor label when a node starts implementing a nested interface", () => {
    const plain = model(`
      interface Person {
        id    String @id @default(cuid())
        email String @unique
      }
      interface Staff extends Person {
        team String @index
      }
      node Employee {
        id    String @id @default(cuid())
        email String
        team  String
      }
      node Contractor implements Staff {}
    `);
    const implementing = model(`
      interface Person {
        id    String @id @default(cuid())
        email String @unique
      }
      interface Staff extends Person {
        team String @index
      }
      node Employee implements Staff {}
      node Contractor implements Staff {}
    `);
    const plan = diffSchemaModels(plain, implementing);
    const cypher = cypherOf(plan);
    expect(cypher).toEqual([
      "DROP CONSTRAINT Employee_id_id IF EXISTS",
      "MATCH (n:`Employee`) WHERE NOT n:`Staff` SET n:`Staff`",
      "MATCH (n:`Employee`) WHERE NOT n:`Person` SET n:`Person`",
    ]);
    expect(cypherOf(diffSchemaModels(implementing, plain))).toEqual([
      "MATCH (n:`Employee`) WHERE n:`Staff` REMOVE n:`Staff`",
      "MATCH (n:`Employee`) WHERE n:`Person` REMOVE n:`Person`",
      "CREATE CONSTRAINT Employee_id_id IF NOT EXISTS FOR (n:`Employee`) REQUIRE n.`id` IS UNIQUE",
    ]);
  });

  it("migrates a new field of an ancestor once, on its label", () => {
    const v2 = model(`
      interface Person {
        id    String @id @default(cuid())
        email String @unique
        role  String @default("member")
      }
      interface Staff extends Person {
        team String @index
      }
      node Employee implements Staff {}
      node Contractor implements Staff {}
      node Customer implements Person {}
    `);
    expect(diffSchemaModels(nested, v2).steps.map((s) => s.comment)).toEqual([
      "Backfill Person.role with its default on existing nodes.",
    ]);
  });

  it("does not move data when a field moves up to an ancestor", () => {
    const moved = model(`
      interface Person {
        id    String @id @default(cuid())
        email String @unique
        team  String?
      }
      interface Staff extends Person {}
      node Employee implements Staff {}
      node Contractor implements Staff {}
      node Customer implements Person {}
    `);
    const plan = diffSchemaModels(nested, moved);
    expect(plan.steps.some((s) => s.kind === "destructive")).toBe(false);
    expect(cypherOf(plan)).toEqual(["DROP INDEX Staff_team_idx IF EXISTS"]);
  });

  it("plans a first migration with nested interfaces", () => {
    const plan = diffSchemaModels(EMPTY_SCHEMA_MODEL, nested);
    expect(plan.steps.every((s) => s.kind === "statement" && s.cypher.startsWith("CREATE"))).toBe(
      true,
    );
  });
});
