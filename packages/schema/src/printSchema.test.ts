import { describe, expect, it } from "vitest";
import { parseSchema } from "./parseSchema.js";
import { printSchemaDocument } from "./printSchema.js";

const fixture = `
node User {
  id        String   @id @default(cuid())
  email     String   @unique
  posts Post[] @relationship(type: "AUTHORED", direction: OUT)
}

node Post {
  id String @id
}
`;

describe("printSchemaDocument", () => {
  it("round-trips through parse → print → parse", () => {
    const a = parseSchema(fixture);
    const printed = printSchemaDocument(a);
    const b = parseSchema(printed);
    expect(b).toEqual(a);
  });

  it("includes relationship blocks", () => {
    const doc = parseSchema(`
      node A { x String @id }
      relationship R { type "T" from A to A
        meta String
      }
    `);
    const out = printSchemaDocument(doc);
    expect(out).toContain("relationship R {");
    expect(out).toContain('type "T"');
    expect(out).toContain("meta String");
  });
});
