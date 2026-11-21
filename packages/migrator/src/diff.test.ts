import { parseSchema, resolveSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { EMPTY_SCHEMA_MODEL, ddlObjectsFromModel, diffSchemaModels, isEmptyPlan } from "./diff.js";
import {
  constraintStatementsFromSchema,
  fulltextIndexStatementsFromSchema,
  indexStatementsFromSchema,
  vectorIndexStatementsFromSchema,
} from "./push.js";
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

describe("vector indexes", () => {
  const chunk = (field: string) => model(`node Chunk { id String @id\n ${field} }`);
  const ddl = (field: string) =>
    ddlObjectsFromModel(chunk(field)).filter((o) => o.name.endsWith("_vector") || o.name === "ci");

  it("emits CREATE VECTOR INDEX with dimensions and similarity", () => {
    expect(ddl("embedding Vector(1536)? @vectorIndex(similarity: cosine)")).toEqual([
      {
        name: "Chunk_embedding_vector",
        kind: "index",
        create:
          "CREATE VECTOR INDEX Chunk_embedding_vector IF NOT EXISTS FOR (n:`Chunk`) ON n.`embedding` OPTIONS {indexConfig: {`vector.dimensions`: 1536, `vector.similarity_function`: 'cosine'}}",
      },
    ]);
    expect(
      ddl('e Vector(8) @vectorIndex(similarity: euclidean, name: "ci", quantization: false)')[0]!
        .create,
    ).toBe(
      "CREATE VECTOR INDEX ci IF NOT EXISTS FOR (n:`Chunk`) ON n.`e` OPTIONS {indexConfig: {`vector.dimensions`: 8, `vector.similarity_function`: 'euclidean', `vector.quantization.enabled`: false}}",
    );
    expect(ddl("embedding Vector(3)?")).toEqual([]);
  });

  it("matches cyphra push and schema ddl", () => {
    const doc = parseSchema(
      `node Chunk { id String @id\n embedding Vector(3)? @vectorIndex(similarity: cosine) }`,
    );
    const fromDiff = ddlObjectsFromModel(resolveSchema(doc))
      .filter((o) => o.create.startsWith("CREATE VECTOR"))
      .map((o) => o.create);
    expect(vectorIndexStatementsFromSchema(doc)).toEqual(fromDiff);
  });

  it("detects added, removed and changed vector indexes", () => {
    const v1 = chunk("embedding Vector(3)? @vectorIndex(similarity: cosine)");
    const comments = (a: typeof v1, b: typeof v1) =>
      diffSchemaModels(a, b).steps.map((s) => s.comment);

    expect(comments(chunk("embedding Vector(3)?"), v1)).toEqual([
      "Create index Chunk_embedding_vector.",
    ]);
    expect(comments(v1, chunk("embedding Vector(3)?"))).toEqual([
      "Drop index Chunk_embedding_vector.",
    ]);
    expect(isEmptyPlan(diffSchemaModels(v1, v1))).toBe(true);

    // A similarity or dimension change recreates the index (drop first, create last).
    const euclid = chunk("embedding Vector(3)? @vectorIndex(similarity: euclidean)");
    const plan = diffSchemaModels(v1, euclid);
    expect(plan.steps.map((s) => s.kind === "statement" && s.cypher)).toEqual([
      "DROP INDEX Chunk_embedding_vector IF EXISTS",
      expect.stringContaining("`vector.similarity_function`: 'euclidean'"),
    ]);
    const wider = diffSchemaModels(
      v1,
      chunk("embedding Vector(1536)? @vectorIndex(similarity: cosine)"),
    );
    expect(wider.steps.map((s) => s.comment)).toEqual([
      "Drop index Chunk_embedding_vector.",
      "Create index Chunk_embedding_vector.",
    ]);
    expect(wider.warnings.join("\n")).toMatch(
      /Chunk\.embedding changed dimensions 3 → 1536; existing embeddings/,
    );

    // A rename drops the old index and creates the new one.
    const renamed = chunk('embedding Vector(3)? @vectorIndex(similarity: cosine, name: "emb")');
    expect(comments(v1, renamed)).toEqual([
      "Drop index Chunk_embedding_vector.",
      "Create index emb.",
    ]);
  });

  it("guards a vector that becomes required", () => {
    const plan = diffSchemaModels(chunk("embedding Vector(3)?"), chunk("embedding Vector(3)"));
    expect(plan.steps.map((s) => s.kind)).toEqual(["guard"]);
    expect(plan.warnings).toEqual([]);
  });
});

describe("full-text indexes", () => {
  const post = (attrs: string) =>
    model(
      `node Post {\n id String @id\n title String\n body String?\n tags String[]\n ${attrs}\n}`,
    );
  const fulltext = (attrs: string) =>
    ddlObjectsFromModel(post(attrs)).filter((o) => o.create.startsWith("CREATE FULLTEXT"));

  it("emits CREATE FULLTEXT INDEX with fields and options", () => {
    expect(
      fulltext(
        '@@fulltext([title, body], name: "postSearch", analyzer: "standard-no-stop-words", eventuallyConsistent: false)',
      ),
    ).toEqual([
      {
        name: "postSearch",
        kind: "index",
        create:
          "CREATE FULLTEXT INDEX postSearch IF NOT EXISTS FOR (n:`Post`) ON EACH [n.`title`, n.`body`] OPTIONS {indexConfig: {`fulltext.analyzer`: 'standard-no-stop-words', `fulltext.eventually_consistent`: false}}",
      },
    ]);
    expect(fulltext("@@fulltext([tags])")).toEqual([
      {
        name: "Post_tags_fulltext",
        kind: "index",
        create:
          "CREATE FULLTEXT INDEX Post_tags_fulltext IF NOT EXISTS FOR (n:`Post`) ON EACH [n.`tags`]",
      },
    ]);
    expect(fulltext("")).toEqual([]);
  });

  it("matches cyphra push and schema ddl", () => {
    const doc = parseSchema(
      `node Post { id String @id\n title String\n @@fulltext([title], analyzer: "english") }`,
    );
    const fromDiff = ddlObjectsFromModel(resolveSchema(doc))
      .filter((o) => o.create.startsWith("CREATE FULLTEXT"))
      .map((o) => o.create);
    expect(fulltextIndexStatementsFromSchema(doc)).toEqual(fromDiff);
    expect(fromDiff).toHaveLength(1);
  });

  it("detects added, removed and changed full-text indexes", () => {
    const v1 = post('@@fulltext([title, body], name: "postSearch")');
    const comments = (a: typeof v1, b: typeof v1) =>
      diffSchemaModels(a, b).steps.map((s) => s.comment);

    expect(comments(post(""), v1)).toEqual(["Create index postSearch."]);
    expect(comments(v1, post(""))).toEqual(["Drop index postSearch."]);
    expect(isEmptyPlan(diffSchemaModels(v1, v1))).toBe(true);

    // Changed fields or analyzer recreate the index (drop first, create last).
    const wider = post('@@fulltext([title, body, tags], name: "postSearch")');
    expect(
      diffSchemaModels(v1, wider).steps.map((s) => s.kind === "statement" && s.cypher),
    ).toEqual([
      "DROP INDEX postSearch IF EXISTS",
      expect.stringContaining("ON EACH [n.`title`, n.`body`, n.`tags`]"),
    ]);
    const english = post('@@fulltext([title, body], name: "postSearch", analyzer: "english")');
    expect(comments(v1, english)).toEqual(["Drop index postSearch.", "Create index postSearch."]);
    const eventual = post(
      '@@fulltext([title, body], name: "postSearch", eventuallyConsistent: true)',
    );
    expect(comments(v1, eventual)).toEqual(["Drop index postSearch.", "Create index postSearch."]);

    // A rename drops the old index and creates the new one.
    expect(comments(v1, post('@@fulltext([title, body], name: "search")'))).toEqual([
      "Drop index postSearch.",
      "Create index search.",
    ]);
  });
});

describe("enum, Json and BigInt fields", () => {
  const before = model(`
    enum Role { ADMIN USER GUEST }
    node User {
      id    String @id
      role  Role   @default(USER)
      roles Role[]
    }
    relationship Knows { type "KNOWS"
      from User
      to User
      level Role? }
  `);

  it("needs no DDL or data step when enum values are added", () => {
    const after = model(`
      enum Role { ADMIN USER GUEST OWNER }
      node User {
        id    String @id
        role  Role   @default(USER)
        roles Role[]
      }
      relationship Knows { type "KNOWS"
        from User
        to User
        level Role? }
    `);
    const plan = diffSchemaModels(before, after);
    expect(plan.steps).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("warns (with a query to find them) when a value is removed", () => {
    const after = model(`
      enum Role { ADMIN USER }
      node User {
        id    String @id
        role  Role   @default(USER)
        roles Role[]
      }
      relationship Knows { type "KNOWS"
        from User
        to User
        level Role? }
    `);
    const plan = diffSchemaModels(before, after);
    expect(plan.steps).toEqual([]);
    expect(plan.warnings).toEqual([
      "User.role no longer accepts GUEST (removed from enum Role); existing values are not migrated. Find them with `MATCH (n:`User`) WHERE n.`role` IN ['GUEST'] RETURN count(*)` and rewrite them in this migration (e.g. SET n.`role` = 'ADMIN').",
      "User.roles no longer accepts GUEST (removed from enum Role); existing values are not migrated. Find them with `MATCH (n:`User`) WHERE any(v IN n.`roles` WHERE v IN ['GUEST']) RETURN count(*)` and rewrite them in this migration (e.g. SET n.`roles` = [v IN n.`roles` WHERE NOT v IN ['GUEST']]).",
      "Knows.level no longer accepts GUEST (removed from enum Role); existing values are not migrated. Find them with `MATCH ()-[r:`KNOWS`]->() WHERE r.`level` IN ['GUEST'] RETURN count(*)` and rewrite them in this migration (e.g. SET r.`level` = 'ADMIN').",
    ]);
  });

  it("reports a change of enum type by name", () => {
    const after = model(`
      enum Role { ADMIN USER GUEST }
      enum Kind { A B }
      node User {
        id    String @id
        role  Kind   @default(A)
        roles Role[]
      }
    `);
    expect(diffSchemaModels(before, after).warnings.join("\n")).toMatch(
      /User\.role changed type Role → Kind/,
    );
  });

  it("backfills BigInt (all 64 bits), Json and enum defaults", () => {
    const after = model(`
      enum Role { ADMIN USER GUEST }
      node User {
        id    String @id
        role  Role   @default(USER)
        roles Role[]
        big   BigInt @default(9223372036854775807)
        prefs Json   @default("{\\"a\\": 1}")
        kind  Role   @default(GUEST)
      }
    `);
    const steps = diffSchemaModels(before, after).steps.filter((s) => s.kind === "statement");
    expect(steps).toEqual([
      expect.objectContaining({
        cypher: "MATCH (n:`User`) WHERE n.`big` IS NULL SET n.`big` = toInteger($value)",
        params: { value: "9223372036854775807" },
      }),
      expect.objectContaining({
        cypher: "MATCH (n:`User`) WHERE n.`prefs` IS NULL SET n.`prefs` = $value",
        params: { value: '{"a":1}' },
      }),
      expect.objectContaining({
        cypher: "MATCH (n:`User`) WHERE n.`kind` IS NULL SET n.`kind` = $value",
        params: { value: "GUEST" },
      }),
    ]);
  });
});
