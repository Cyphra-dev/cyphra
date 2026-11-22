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

  it("keys a relationship model to a union by its type: same DDL and data steps as to a node", () => {
    const edge = (to: string, extra = "") =>
      model(`
        ${NODES}
        union SearchHit = Post | User
        node Tag {
          id      String      @id
          targets ${to}[] @relationship(type: "TAGS", direction: OUT)
        }
        relationship Tagging {
          type "TAGS"
          from Tag
          to   ${to}
          ref  String @unique
          rank Int    @index${extra}
        }
      `);
    expect(ddlObjectsFromModel(edge("SearchHit"))).toEqual(ddlObjectsFromModel(edge("Post")));
    const created = ddlObjectsFromModel(edge("SearchHit")).map((o) => o.create);
    expect(created).toContain(
      "CREATE CONSTRAINT Tagging_ref_rel_unique IF NOT EXISTS FOR ()-[r:`TAGS`]-() REQUIRE r.`ref` IS UNIQUE",
    );
    const plan = diffSchemaModels(
      edge("SearchHit"),
      edge("SearchHit", "\n          weight Int @default(1)"),
    );
    expect(plan.steps.map((s) => ("cypher" in s ? s.cypher : ""))).toContain(
      "MATCH ()-[r:`TAGS`]->() WHERE r.`weight` IS NULL SET r.`weight` = toInteger($value)",
    );
  });

  it("has no step when a union gains an interface member", () => {
    const base = `${NODES} interface P { k String @id } node E implements P {}`;
    const plan = diffSchemaModels(
      model(`${base} union U = Post`),
      model(`${base} union U = Post | P`),
    );
    expect(plan.steps).toEqual([]);
  });
});
