import { describe, expect, it } from "vitest";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { twoFactor } from "better-auth/plugins";
import { authSchema, mergeAuthSchema } from "./index.js";

const core = authSchema({}).document;

const userFile = `// App schema
node User {
  id    String @id @default(cuid())
  email String @unique // login
  name  String
  // business data
  projects Project[] @out(OWNS)
  plan     String    @default("free")
}

node Project {
  id    String @id @default(uuid())
  title String
  owner User   @in(OWNS)
}

relationship Owns {
  type "OWNS"
  from User
  to Project
  since DateTime @default(now())
}
`;

describe("mergeAuthSchema", () => {
  it("writes a fresh schema when there is no file", () => {
    const out = mergeAuthSchema(undefined, core);
    expect(out).toMatch(/^\/\/ Better Auth models/);
    const model = resolveSchema(parseSchema(out));
    expect(model.nodes.map((n) => n.name)).toEqual(["User", "Session", "Account", "Verification"]);
  });

  it("keeps the developer's fields, models, relationships and comments", () => {
    const out = mergeAuthSchema(userFile, core);
    // Untouched lines stay byte for byte.
    for (const line of [
      "// App schema",
      "  id    String @id @default(cuid())",
      "  email String @unique // login",
      "  name  String",
      "  // business data",
      "  projects Project[] @out(OWNS)",
      '  plan     String    @default("free")',
    ]) {
      expect(out).toContain(line);
    }
    expect(out).toContain(userFile.slice(userFile.indexOf("node Project")).trimEnd());
    // Better Auth fields are added to User, and the missing auth nodes are appended.
    expect(out).toContain("  emailVerified Boolean\n");
    expect(out).toContain("  sessions Session[] @out(HAS_SESSION, onDelete: Cascade)");
    expect(out).toMatch(/node Session \{[\s\S]*user User @in\(HAS_SESSION/);

    const model = resolveSchema(parseSchema(out));
    const user = model.nodes.find((n) => n.name === "User")!;
    expect(user.fields.map((f) => f.name)).toEqual([
      "id",
      "email",
      "name",
      "projects",
      "plan",
      "emailVerified",
      "image",
      "createdAt",
      "updatedAt",
      "sessions",
      "accounts",
    ]);
    expect(model.nodes.map((n) => n.name)).toEqual([
      "User",
      "Project",
      "Session",
      "Account",
      "Verification",
    ]);
  });

  it("is idempotent and updates changed auth fields in place", () => {
    const once = mergeAuthSchema(userFile, core);
    expect(mergeAuthSchema(once, core)).toBe(once);

    // A plugin adds fields and a model; an outdated auth field is rewritten on its own line.
    const edited = once.replace("  image String?\n", "  image String // custom comment\n");
    const out = mergeAuthSchema(edited, authSchema({ plugins: [twoFactor()] }).document);
    expect(out).toContain("  image String? // custom comment\n");
    expect(out).toContain("  twoFactorEnabled Boolean?\n");
    expect(out).toContain("  twoFactors TwoFactor[] @out(HAS_TWO_FACTOR, onDelete: Cascade)");
    expect(out).toContain("node TwoFactor {");
    expect(out).toContain("  projects Project[] @out(OWNS)");
  });

  it("keeps the developer's @@ attributes and adds Better Auth's compound indexes", () => {
    const plugin = {
      id: "handles",
      schema: {
        user: {
          fields: {
            tenant: { type: "string", required: true },
            handle: { type: "string", required: true },
          },
          indexes: [{ fields: ["tenant", "handle"], unique: true }],
        },
      },
    } as const;
    const auth = authSchema({ plugins: [plugin] }).document;
    const withAttr = userFile.replace(
      '  plan     String    @default("free")\n',
      '  plan     String    @default("free")\n\n  @@index([plan, name]) // mine\n',
    );
    const out = mergeAuthSchema(withAttr, auth);
    expect(out).toContain('  plan     String    @default("free")\n  emailVerified Boolean\n');
    expect(out).toContain("  @@index([plan, name]) // mine\n  @@unique([tenant, handle])\n}");
    expect(mergeAuthSchema(out, auth)).toBe(out);
    const user = resolveSchema(parseSchema(out)).nodes.find((n) => n.name === "User")!;
    expect(user.compoundUniques?.map((c) => c.key)).toEqual(["tenant_handle"]);

    // Without attributes yet: added after a blank line at the end of the block.
    const fresh = mergeAuthSchema(userFile, auth);
    expect(fresh).toMatch(
      /\n {2}accounts Account\[\][^\n]*\n\n {2}@@unique\(\[tenant, handle\]\)\n\}/,
    );
  });

  it("reprints a node whose layout it cannot edit line by line, keeping extra fields", () => {
    const compact = `node User { id String @id
  projects Project[] @out(OWNS) }
node Project {
  id String @id
  owner User? @in(OWNS)
}
`;
    const out = mergeAuthSchema(compact, core);
    const user = resolveSchema(parseSchema(out)).nodes.find((n) => n.name === "User")!;
    expect(user.fields.map((f) => f.name)).toContain("projects");
    expect(user.fields.map((f) => f.name)).toContain("emailVerified");
  });

  it("replaces a clashing auth field and throws on a file that does not parse", () => {
    const clash = `node User {
  id String @id
  sessions Ghost[] @out(X)
}
node Ghost {
  id String @id
}
`;
    expect(mergeAuthSchema(clash, core)).toContain(
      "  sessions Session[] @out(HAS_SESSION, onDelete: Cascade)",
    );
    expect(() => mergeAuthSchema("node User {", core)).toThrow();
  });
});
