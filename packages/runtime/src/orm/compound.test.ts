import { describe, expect, it } from "vitest";
import neo4j from "neo4j-driver";
import { schemaModel } from "./__fixtures__/compound.gen.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError } from "./errors.js";

type Call = { text: string; params: Record<string, unknown> };

function engine(name: string, answer: (text: string) => Record<string, unknown>[]) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    calls.push({ text, params });
    return answer(text);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const model = schemaModel.nodes.find((n) => n.name === name)!;
  return { calls, e: new ModelEngine(schemaModel, model, runner) };
}

const memberRow = {
  id: "m1",
  tenantId: "t1",
  email: "a@x.io",
  role: "member",
  joinedOn: neo4j.int(1),
};

describe("@@unique keys in unique where", () => {
  it("flattens a compound key into its fields for findUnique", async () => {
    const { calls, e } = engine("Member", () => [{ row: memberRow }]);
    const m = await e.findUnique({
      where: { tenantId_email: { tenantId: "t1", email: "a@x.io" } },
    });
    expect(m?.id).toBe("m1");
    expect(calls[0]!.text).toMatch(
      /^MATCH \(n:`Member`\) WHERE \(n\.`tenantId` = \$p0\) AND \(n\.`email` = \$p1\)/,
    );
    expect(calls[0]!.params).toMatchObject({ p0: "t1", p1: "a@x.io" });
  });

  it("upserts with a MERGE on every field of the key", async () => {
    const { calls, e } = engine("Slot", () => [{ id: "4:x:0", row: { day: 1, room: "A" } }]);
    await e.upsert({
      where: { dayRoom: { day: 1, room: "A" } },
      create: { label: "standup", day: 1 },
      update: { label: "retro" },
    });
    expect(calls[0]!.text).toBe(
      "MERGE (n:`Slot` {`day`: $p0, `room`: $p1}) ON CREATE SET n += $p2 ON MATCH SET n.`label` = $p3" +
        " RETURN elementId(n) AS id, n{.`day`, .`room`, .`label`} AS row",
    );
    expect(calls[0]!.params.p2).toEqual({ label: "standup" });
  });

  it("prefers a single unique field as the MERGE key and checks the compound key as a filter", async () => {
    const { calls, e } = engine("Member", () => [{ id: "4:x:0", created: false, row: memberRow }]);
    await e.upsert({
      where: { id: "m1", tenantId_email: { tenantId: "t1", email: "a@x.io" } },
      create: { tenantId: "t1", email: "a@x.io", joinedOn: 1 },
      update: {},
    });
    expect(calls[0]!.text).toMatch(/^MERGE \(n:`Member` \{`id`: \$p0\}\)/);
    expect(calls[0]!.text).toContain("WHERE created OR (");
  });

  it("also accepts the key's fields set directly (untyped callers)", async () => {
    const { calls, e } = engine("Member", () => [{ row: memberRow }]);
    await e.findUnique({ where: { tenantId: "t1", email: "a@x.io" } });
    expect(calls).toHaveLength(1);
  });

  it("rejects incomplete, null or mismatched compound keys", async () => {
    const { e } = engine("Member", () => []);
    const cases: [unknown, RegExp][] = [
      [{ tenantId_email: { tenantId: "t1" } }, /where\.tenantId_email must set email/],
      [{ tenantId_email: { tenantId: "t1", email: null } }, /must be a value/],
      [{ tenantId_email: { tenantId: "t1", email: { contains: "a" } } }, /must be a value/],
      [
        { tenantId_email: { tenantId: "t1", email: "a", role: "x" } },
        /role is not a field of the key/,
      ],
      [{ tenantId_email: "t1" }, /must be an object with tenantId, email/],
      [{ tenantId: "t2", tenantId_email: { tenantId: "t1", email: "a" } }, /differ/],
      [
        { tenantId: "t1" },
        /at least one unique field \(id, tenantId_email \{ tenantId, email \}\)/,
      ],
    ];
    for (const [where, message] of cases) {
      await expect(e.findUnique({ where })).rejects.toThrow(CyphraValidationError);
      await expect(e.findUnique({ where })).rejects.toThrow(message);
    }
    const slot = engine("Slot", () => []).e;
    await expect(
      slot.upsert({ where: { dayRoom: { day: 1, room: "A" } }, create: { day: 2 }, update: {} }),
    ).rejects.toThrow(/create\.day must equal where\.day/);
  });
});
