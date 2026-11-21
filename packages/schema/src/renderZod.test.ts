import { describe, expect, it } from "vitest";
import { parseSchema } from "./parseSchema.js";
import { renderZodSource } from "./renderZod.js";

const SCHEMA = `
node User {
  id        String   @id @default(cuid())
  email     String   @unique
  role      String   @default("member")
  createdAt DateTime @default(now())
  token     String   @default(uuid())
  follows   User[]   @relationship(type: "FOLLOWS", direction: OUT)
}

node Tag {
  slug String @id
}

relationship Follows {
  type "FOLLOWS"
  from User
  to User
  since DateTime @default(now())
  note  String?
}
`;

/** The `z.object({ … })` body of an exported schema. */
function objectOf(source: string, name: string): string {
  const m = new RegExp(`export const ${name} = z\\.object\\(\\{([^]*?)\\}\\);`).exec(source);
  if (!m) throw new Error(`${name} not found`);
  return m[1]!;
}

describe("renderZodSource omitGenerated", () => {
  it("keeps every field in input schemas by default", () => {
    const out = renderZodSource(parseSchema(SCHEMA));
    const create = objectOf(out, "UserCreateInputSchema");
    expect(create).toContain("id: UserFields.id.optional(),");
    expect(create).toContain("createdAt: UserFields.createdAt.optional(),");
    expect(out).not.toContain("generated fields");
  });

  it("leaves @id defaults and function defaults out of create and update inputs", () => {
    const out = renderZodSource(parseSchema(SCHEMA), { omitGenerated: true });
    for (const name of ["UserCreateInputSchema", "UserUpdateInputSchema"]) {
      const body = objectOf(out, name);
      expect(body).not.toMatch(/\b(id|createdAt|token):/);
      expect(body).toMatch(/email:/);
      // A literal default is not generated: the caller may still set it.
      expect(body).toMatch(/role:/);
    }
    // The output schema still describes every property.
    expect(objectOf(out, "UserSchema")).toMatch(/id: UserFields\.id,/);
    // An @id without a default is supplied by the caller.
    expect(objectOf(out, "TagCreateInputSchema")).toContain("slug: TagFields.slug,");
    // Edge properties too.
    expect(objectOf(out, "FollowsCreateInputSchema")).not.toContain("since");
    expect(objectOf(out, "FollowsCreateInputSchema")).toContain("note:");
    expect(out).toContain("generated fields are left out");
  });

  it("writes an empty object when every field is generated", () => {
    const out = renderZodSource(parseSchema("node Ping { id String @id @default(uuid()) }"), {
      omitGenerated: true,
    });
    expect(out).toContain("export const PingCreateInputSchema = z.object({});");
  });
});
