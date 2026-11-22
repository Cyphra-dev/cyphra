import { parseSchema, resolveSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { ddlObjectsFromModel, diffSchemaModels } from "./diff.js";

const model = (src: string) => resolveSchema(parseSchema(src));
const NODES = `
  node Post { id String @id }
  node User { id String @id  email String @unique }
`;
const WITH_UNION = model(`
  ${NODES}
  union SearchHit = Post | User
  node Tag {
    id      String      @id
    targets SearchHit[] @relationship(type: "TAGS", direction: OUT)
  }
`);

describe("migrations: unions", () => {
  it("creates no DDL for a union", () => {
    const plain = model(`${NODES} node Tag { id String @id }`);
    expect(ddlObjectsFromModel(WITH_UNION)).toEqual(ddlObjectsFromModel(plain));
  });

  it("has no step when a union is added or removed", () => {
    const before = model(NODES);
    const after = model(`${NODES} union SearchHit = Post | User`);
    for (const [a, b] of [
      [before, after],
      [after, before],
    ] as const) {
      const plan = diffSchemaModels(a, b);
      expect(plan.steps).toEqual([]);
      expect(plan.warnings).toEqual([]);
    }
  });

  it("does not read a removed union and an added node as a rename", () => {
    const before = model(`${NODES} union SearchHit = Post | User`);
    const after = model(`${NODES} node Comment { id String @id }`);
    expect(diffSchemaModels(before, after).warnings).toEqual([]);
  });
});
