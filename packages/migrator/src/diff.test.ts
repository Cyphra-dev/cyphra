import { parseSchema, resolveSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { EMPTY_SCHEMA_MODEL, ddlObjectsFromModel, diffSchemaModels, isEmptyPlan } from "./diff.js";
import { constraintStatementsFromSchema, indexStatementsFromSchema } from "./push.js";
import { renderMigrationSource } from "./renderMigration.js";

const model = (src: string) => resolveSchema(parseSchema(src));

const v1 = model(`
  node User {
    id    String @id @default(cuid())
    email String @unique
    name  String @index
    bio   String?
  }
  relationship Follows { type "FOLLOWS"
    from User
    to User
    key String @unique }
`);

describe("ddlObjectsFromModel", () => {
  it("names objects exactly like cyphra push", () => {
    const doc = parseSchema(
      `node User { id String @id\n email String @unique\n name String @index }`,
    );
    const names = (stmts: string[]) => stmts.map((s) => /(?:CONSTRAINT|INDEX) (\S+)/.exec(s)![1]);
    const fromPush = [
      ...names(constraintStatementsFromSchema(doc)),
      ...names(indexStatementsFromSchema(doc)),
    ];
    expect(
      ddlObjectsFromModel(resolveSchema(doc))
        .map((o) => o.name)
        .sort(),
    ).toEqual(fromPush.sort());
  });
});

describe("diffSchemaModels", () => {
  it("creates every constraint and index for a first migration, with no data steps", () => {
    const plan = diffSchemaModels(EMPTY_SCHEMA_MODEL, v1);
    expect(plan.steps.map((s) => s.comment)).toEqual([
      "Create constraint User_id_id.",
      "Create constraint User_email_unique.",
      "Create index User_name_idx.",
      "Create constraint Follows_key_rel_unique.",
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("is empty when nothing changed", () => {
    expect(isEmptyPlan(diffSchemaModels(v1, v1))).toBe(true);
  });

  it("drops removed DDL first, fixes data, then creates new DDL", () => {
    const v2 = model(`
      node User {
        id     String  @id @default(cuid())
        email  String
        name   String
        bio    String  @default("")
        handle String  @unique
        score  Int     @default(0)
        joined DateTime @default(now())
      }
    `);
    const plan = diffSchemaModels(v1, v2);
    const kinds = plan.steps.map((s) => `${s.kind}: ${s.comment}`);
    expect(kinds).toEqual([
      "statement: Drop constraint User_email_unique.",
      "statement: Drop index User_name_idx.",
      "statement: Drop constraint Follows_key_rel_unique.",
      "statement: Backfill User.bio with its default on existing nodes.",
      "guard: User.handle is now required and has no default: make sure no existing node lacks it.",
      "statement: Backfill User.score with its default on existing nodes.",
      "statement: Backfill User.joined with its default on existing nodes.",
      "statement: Create constraint User_handle_unique.",
    ]);
    const score = plan.steps.find((s) => s.comment.includes("User.score"));
    expect(score).toMatchObject({
      cypher: "MATCH (n:`User`) WHERE n.`score` IS NULL SET n.`score` = toInteger($value)",
      params: { value: 0 },
    });
  });

  it("emits destructive steps and rename hints for removed fields and models", () => {
    const v2 = model(
      `node Person { id String @id }\nnode User { id String @id @default(cuid())\n email String @unique\n fullName String? }`,
    );
    const plan = diffSchemaModels(v1, v2);
    const destructive = plan.steps.filter((s) => s.kind === "destructive").map((s) => s.cypher);
    expect(destructive).toContain("MATCH (n:`User`) WHERE n.`bio` IS NOT NULL REMOVE n.`bio`");
    expect(plan.warnings.join("\n")).toMatch(/renameProperty/);
    const dropped = diffSchemaModels(v2, model(`node User { id String @id }`));
    expect(
      dropped.steps.some((s) => s.kind === "destructive" && s.cypher.includes("DETACH DELETE")),
    ).toBe(true);
  });

  it("warns on type changes and backfills cuid with randomUUID", () => {
    const a = model(`node A { id String @id\n n String? }`);
    const b = model(`node A { id String @id\n n Int?\n ref String @default(cuid()) }`);
    const plan = diffSchemaModels(a, b);
    expect(plan.warnings.join("\n")).toMatch(/A\.n changed type String\? → Int\?/);
    expect(plan.steps.find((s) => s.comment.includes("A.ref"))).toMatchObject({
      cypher: expect.stringContaining("randomUUID()"),
    });
  });
});

describe("renderMigrationSource", () => {
  it("renders runnable steps, guards and commented-out destructive steps", () => {
    const v2 = model(
      `node User { id String @id @default(cuid())\n email String @unique\n name String @index\n handle String }`,
    );
    const src = renderMigrationSource(diffSchemaModels(v1, v2), {
      name: "20260101000000_x",
      runtimeImport: "cyphra",
    });
    expect(src).toContain('import { defineMigration } from "cyphra";');
    expect(src).toContain('name: "20260101000000_x",');
    expect(src).toContain("throw new Error(");
    expect(src).toContain(
      '// await db.execute("MATCH (n:`User`) WHERE n.`bio` IS NOT NULL REMOVE n.`bio`");',
    );
    expect(src).toContain('await db.execute("DROP CONSTRAINT Follows_key_rel_unique IF EXISTS");');
  });
});
