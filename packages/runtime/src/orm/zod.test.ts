/**
 * The zod generator (`renderZodSource`): golden files of a schema with every scalar type and
 * every validation rule, and parity with the runtime: for each value, the generated schemas (zod 4
 * and zod 3, strict and coercing) accept it exactly when a write through the ORM does.
 */
import { readFile } from "node:fs/promises";
import {
  parseSchema,
  renderZodSource,
  resolveSchema,
  type RenderZodOptions,
  type ResolvedScalarField,
} from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import * as v3 from "./__fixtures__/zod.v3.zod.gen.js";
import * as v3Coerce from "./__fixtures__/zod.v3.coerce.zod.gen.js";
import * as v4 from "./__fixtures__/zod.zod.gen.js";
import * as v4Coerce from "./__fixtures__/zod.coerce.zod.gen.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError } from "./errors.js";
import { validateWriteArgs } from "./rules.js";
import { encodeScalar } from "./values.js";

const dir = new URL("./__fixtures__/", import.meta.url);
const source = await readFile(new URL("zod.cyphra", dir), "utf8");
const schema = resolveSchema(parseSchema(source));

const GOLDEN: [string, RenderZodOptions][] = [
  ["zod.zod.gen.ts", {}],
  ["zod.coerce.zod.gen.ts", { coerce: true }],
  ["zod.v3.zod.gen.ts", { zodImport: "zod3" }],
  ["zod.v3.coerce.zod.gen.ts", { zodImport: "zod3", coerce: true }],
];

describe("renderZodSource", () => {
  it.each(GOLDEN)("is in sync with %s (run the generator if this fails)", async (file, opts) => {
    const golden = await readFile(new URL(file, dir), "utf8");
    expect(renderZodSource(parseSchema(source), opts)).toBe(golden);
  });

  it("only emits the helpers a schema uses", () => {
    const out = renderZodSource(parseSchema("node A { id String @id\n n Int? }"));
    expect(out).not.toMatch(/cyphra[A-Z]/);
    expect(out).toContain("export const ASchema = z.object({");
    expect(out).toContain("n: AFields.n.nullable(),");
  });

  it("takes the zod import and handles models without scalar fields", () => {
    const out = renderZodSource(
      parseSchema(
        'node A { id String @id\n b B? @relationship(type: "R", direction: OUT) }\nnode B { a A? @relationship(type: "R", direction: IN) }',
      ),
      { zodImport: "zod/v4" },
    );
    expect(out).toContain('import { z } from "zod/v4";');
    expect(out).toContain("export const BSchema = z.object({});");
    expect(out).not.toContain("b: ");
  });

  it("gives an interface no create schema, and its implementations the inherited fields", () => {
    const out = renderZodSource(
      parseSchema(
        "interface Person { name String }\nnode Employee implements Person { id String @id\n team String }",
      ),
    );
    expect(out).toContain("export const PersonSchema");
    expect(out).toContain("export const PersonUpdateInputSchema");
    expect(out).not.toContain("PersonCreateInputSchema");
    expect(out).toContain("export const EmployeeCreateInputSchema");
    const employee = out.slice(out.indexOf("const EmployeeFields"));
    expect(employee.slice(0, employee.indexOf("};"))).toContain("name:");
  });
});

// ---------------------------------------------------------------------------------------------
// Parity with the runtime
// ---------------------------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;
type Generated = typeof v4;

const VARIANTS: [string, Generated, boolean][] = [
  ["zod 4", v4, false],
  ["zod 4 coerce", v4Coerce as unknown as Generated, true],
  ["zod 3", v3 as unknown as Generated, false],
  ["zod 3 coerce", v3Coerce as unknown as Generated, true],
];

const user = schema.nodes.find((n) => n.name === "ZdUser")!;
const follows = schema.relationships.find((r) => r.name === "ZdFollows")!;

function engine(): ModelEngine {
  const exec: Executor = async () => [];
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  return new ModelEngine(schema, user, runner);
}

/** `false` when `run` rejects with a validation error, `true` otherwise. */
async function accepts(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (e) {
    if (e instanceof CyphraValidationError) return false;
    throw e;
  }
}

/** Whether the runtime accepts `data` as the scalar data of a create / an update. */
function runtimeAccepts(mode: "create" | "update", data: AnyRecord): Promise<boolean> {
  const e = engine();
  return accepts(() =>
    mode === "create" ? e.createMany({ data: [data] }) : e.updateMany({ where: {}, data }),
  );
}

const BASE: AnyRecord = { email: "ada@example.com", name: "Ada", tags: ["a"], labels: ["x"] };

/** Whether the runtime accepts `data` as the `$edge` properties of a new / an existing edge. */
function runtimeAcceptsEdge(mode: "create" | "update", data: AnyRecord): Promise<boolean> {
  return accepts(async () => {
    if (mode === "create") {
      validateWriteArgs(schema, user, "create", {
        data: { ...BASE, follows: { create: [{ ...BASE, $edge: data }] } },
      });
      // What `$edge` of a new edge goes through (defaults, required fields, types).
      (
        ModelEngine as unknown as {
          createProps(o: string, f: readonly ResolvedScalarField[], d: AnyRecord): AnyRecord;
        }
      ).createProps(follows.name, follows.properties, data);
    } else {
      validateWriteArgs(schema, user, "update", {
        data: { follows: { connect: [{ id: "x", $edge: data }] } },
      });
      for (const f of follows.properties) {
        if (data[f.name] !== undefined) encodeScalar(f, data[f.name], follows.name);
      }
    }
  });
}

const ABSENT = Symbol("absent");

/**
 * A value of `field`: `ok` is whether the runtime accepts it (and the zod schemas with it);
 * `strict` / `coerce` is what the strict / coercing zod schemas say when they deliberately differ.
 */
type Case = {
  readonly field: string;
  readonly value: unknown;
  readonly ok: boolean;
  readonly strict?: boolean;
  readonly coerce?: boolean;
};

function c(field: string, value: unknown, ok: boolean, diff: Partial<Case> = {}): Case {
  return { field, value, ok, ...diff };
}

const dateOnlyInCoerce = { strict: false };
/**
 * Values the runtime takes but the client's types do not (`null` for an empty list or a 2D point's
 * height, a `bigint` for an `Int`): the schemas follow the types.
 */
const outsideTypes = { strict: false, coerce: false };

const CREATE_CASES: Case[] = [
  c("email", "ada@example.com", true),
  c("email", "not-an-email", false),
  c("email", ".ada@example.com", false),
  c("email", "a..b@example.com", false),
  c("email", ABSENT, false),
  c("email", null, false),
  c("email", 5, false),
  c("name", "Al", true),
  c("name", "A", false),
  c("name", "éééééééééé", true),
  c("name", "😀".repeat(10), true), // 10 code points, 20 UTF-16 units
  c("name", "😀".repeat(11), false),
  c("name", "   ", false), // long enough, but blank
  c("name", ABSENT, false),
  c("nick", null, true),
  c("nick", ABSENT, true),
  c("nick", "abcd", true),
  c("nick", "abcde", false),
  c("website", "https://example.com/x", true),
  c("website", "http://example.com", true),
  c("website", "ftp://example.com", false),
  c("website", "example.com", false),
  c("website", "http://", false),
  c("website", "mailto:ada@example.com", false),
  c("handle", "Ada_1", true), // flag i
  c("handle", "ada-1", false),
  c("bio", "", true),
  c("bio", 1, false),
  c("role", "ADMIN", true),
  c("role", "OWNER", false),
  c("role", ABSENT, true),
  c("role", null, false), // required with a default: null is not "use the default"
  c("roles", ["ADMIN", "MEMBER"], true),
  c("roles", ["OWNER"], false),
  c("roles", null, true, outsideTypes),
  c("roles", [], true),
  c("roles", "ADMIN", false),
  c("age", 13, true),
  c("age", 130, true),
  c("age", 12, false),
  c("age", 131, false),
  c("age", 13.5, false),
  c("age", "13", false),
  c("age", null, true),
  c("count", 5, true),
  c("count", -5, true),
  c("count", 1.5, false),
  c("count", 5n, true, outsideTypes), // Int is a `number` in the client's types
  c("score", 0, true),
  c("score", 100, true),
  c("score", 99.5, true),
  c("score", 100.5, false),
  c("score", -0.1, false),
  c("ratio", 1.5, true),
  c("ratio", "1", false),
  c("active", false, true),
  c("active", "true", false),
  c("active", null, false),
  c("balance", 0n, true),
  c("balance", 10n ** 18n, true),
  c("balance", -1n, false),
  c("balance", 2n ** 63n, false),
  c("balance", 5, true, { strict: false }), // a safe integer: coerced
  c("balance", "5", false, { coerce: true }), // API text: only coerced by the schemas
  c("balance", 1.5, false),
  c("big", 2n ** 63n - 1n, true),
  c("big", -(2n ** 63n), true),
  c("big", 2n ** 63n, false),
  c("big", -(2n ** 63n) - 1n, false),
  c("big", "9223372036854775808", false), // out of range, even coerced
  c("big", "12x", false),
  c("big", null, true),
  c("seenAt", new Date("2025-01-01T00:00:00Z"), true),
  c("seenAt", new Date("2020-01-01T00:00:00Z"), true), // bounds are inclusive
  c("seenAt", new Date("2030-01-01T00:00:00Z"), true),
  c("seenAt", new Date("2019-12-31T23:59:59.999Z"), false),
  c("seenAt", new Date("2030-01-01T00:00:00.001Z"), false),
  c("seenAt", new Date("nope"), false),
  c("seenAt", "2025-01-01T00:00:00Z", true, dateOnlyInCoerce),
  c("seenAt", "2025-06-01T12:00:00+02:00", true, dateOnlyInCoerce),
  c("seenAt", "2031-01-01T00:00:00Z", false),
  c("seenAt", "nope", false),
  c("seenAt", 1735689600000, false),
  c("seenAt", ABSENT, true),
  c("seenAt", null, false),
  c("updatedAt", null, true),
  c("born", new Date("1900-01-01T00:00:00Z"), true),
  c("born", new Date("2020-12-31T23:00:00Z"), true), // the calendar day is the bound
  c("born", new Date("2021-01-01T00:00:00Z"), false),
  c("born", new Date("1899-12-31T23:59:59Z"), false),
  c("born", "2000-05-05", true, dateOnlyInCoerce),
  c("born", "2021-05-05", false),
  c("meta", { a: [1, "x", null, { b: true }] }, true),
  c("meta", "text", true),
  c("meta", 5, true),
  c("meta", [], true),
  c("meta", null, true),
  c("prefs", {}, true),
  c("prefs", null, false),
  c("tags", ["a", "b", "c"], true),
  c("tags", [], false),
  c("tags", ["a", "b", "c", "d"], false),
  c("tags", ABSENT, false), // absent lists read as []
  c("tags", null, false),
  c("tags", ["a", 1], false),
  c("labels", [], false),
  c("labels", [""], true),
  c("scores", [1, 2], true),
  c("scores", [1.5], false),
  c("scores", ABSENT, true),
  c("location", { longitude: 2.35, latitude: 48.85 }, true),
  c("location", { longitude: 2.35, latitude: 48.85, height: 35 }, true),
  c("location", { longitude: 2.35, latitude: 48.85, height: null }, true, outsideTypes),
  c("location", { longitude: 181, latitude: 0 }, false),
  c("location", { longitude: 0, latitude: -90.5 }, false),
  c("location", { latitude: 0 }, false),
  c("location", { longitude: 0, latitude: 0, x: 1 }, false),
  c("location", { longitude: "0", latitude: 0 }, false),
  c("location", null, true),
  c("grid", { x: 1, y: 2 }, true),
  c("grid", { x: 1, y: 2, z: 3 }, true),
  c("grid", { x: 1 }, false),
  c("grid", { x: Infinity, y: 0 }, false),
  c("grid", { longitude: 0, latitude: 0 }, false),
  c("route", [{ longitude: 0, latitude: 0 }], true),
  c("route", [{ x: 0, y: 0 }], false),
  c("embedding", [1, 2, 3], true),
  c("embedding", [1, 2], false),
  c("embedding", [1, 2, 3, 4], false),
  c("embedding", [1, 2, "3"], false),
  c("embedding", [1, 2, NaN], false),
  c("embedding", null, true),
  c("opens", "10:30", true),
  c("opens", "10:30:00.123456789", true),
  c("opens", "23:59:59,5", true),
  c("opens", "24:00", false),
  c("opens", "10:60", false),
  c("opens", "10:30:00Z", false),
  c("opens", "1030", false),
  c("slot", "10:30:00+02:00", true),
  c("slot", "10:30:00Z", true),
  c("slot", "10:30:00+0200", true),
  c("slot", "10:30:00-18:00", true),
  c("slot", "10:30:00", false),
  c("slot", "10:30:00+18:01", false),
  c("slot", "10:30:00+02:60", false),
  c("starts", "2024-02-29T10:00", true),
  c("starts", "0004-02-29T00:00", true),
  c("starts", "+012345-01-01T00:00:00", true),
  c("starts", "2023-02-29T10:00", false),
  c("starts", "2024-13-01T00:00", false),
  c("starts", "2024-04-31T00:00", false),
  c("starts", "2024-05-01", false),
  c("starts", "2024-05-01T10:30:00Z", false),
  c("stay", "P1DT2H30M", true),
  c("stay", "PT0S", true),
  c("stay", "-PT5M", true),
  c("stay", "P1M-3D", true),
  c("stay", "P2W", true),
  c("stay", "PT1.5S", true),
  c("stay", "P", false),
  c("stay", "PT", false),
  c("stay", "P1DT", false),
  c("stay", "1D", false),
  c("stay", 5, false),
  c("windows", ["P1D", "PT1H"], true),
  c("windows", ["P1D", "PT1H", "P2D"], false),
  c("windows", ["x"], false),
];

const UPDATE_CASES: Case[] = [
  c("email", ABSENT, true),
  c("email", null, false),
  c("email", "nope", false),
  c("name", "Grace", true),
  c("name", " ", false),
  c("name", null, false),
  c("nick", null, true),
  c("role", null, false),
  c("roles", null, true, outsideTypes),
  c("roles", [], true),
  c("tags", null, false), // an absent list reads as [], which @size(1, 3) refuses
  c("tags", [], false),
  c("tags", ["a"], true),
  c("labels", null, false),
  c("scores", null, true, outsideTypes),
  c("age", 200, false),
  c("age", 20, true),
  c("balance", -1n, false),
  c("balance", "7", false, { coerce: true }),
  c("seenAt", new Date("2010-01-01T00:00:00Z"), false),
  c("seenAt", "2025-01-01T00:00:00Z", true, dateOnlyInCoerce),
  c("born", null, true),
  c("location", null, true),
  c("stay", "PT", false),
];

const EDGE_CREATE_CASES: Case[] = [
  c("level", "ADMIN", true),
  c("level", ABSENT, false),
  c("level", "OWNER", false),
  c("note", "hello", true),
  c("note", "hello!", false),
  c("note", null, true),
  c("since", ABSENT, true),
  c("since", null, false),
  c("since", new Date("2024-01-01T00:00:00Z"), true),
  c("since", "2024-01-01T00:00:00Z", true, dateOnlyInCoerce),
];

const EDGE_UPDATE_CASES: Case[] = [
  c("level", ABSENT, true),
  c("level", null, false),
  c("note", "hello!", false),
  c("note", null, true),
  c("since", "nope", false),
];

function withValue(base: AnyRecord, k: Case): AnyRecord {
  const data = { ...base };
  if (k.value === ABSENT) delete data[k.field];
  else data[k.field] = k.value;
  return data;
}

function label(k: Case): string {
  const v = k.value;
  const shown =
    v === ABSENT
      ? "(absent)"
      : typeof v === "bigint"
        ? `${v}n`
        : v instanceof Date
          ? `Date(${Number.isNaN(v.getTime()) ? "invalid" : v.toISOString()})`
          : JSON.stringify(v);
  return `${k.field} = ${shown}`;
}

function expected(k: Case, coerce: boolean): boolean {
  return (coerce ? k.coerce : k.strict) ?? k.ok;
}

const SUITES: [string, Case[], "create" | "update", AnyRecord, "node" | "edge"][] = [
  ["node create", CREATE_CASES, "create", BASE, "node"],
  ["node update", UPDATE_CASES, "update", {}, "node"],
  ["edge create", EDGE_CREATE_CASES, "create", { level: "MEMBER" }, "edge"],
  ["edge update", EDGE_UPDATE_CASES, "update", {}, "edge"],
];

describe.each(SUITES)("runtime parity: %s", (_name, cases, mode, base, kind) => {
  it.each(cases.map((k) => [label(k), k] as const))("%s", async (_l, k) => {
    const data = withValue(base, k);
    const runtime =
      kind === "node" ? await runtimeAccepts(mode, data) : await runtimeAcceptsEdge(mode, data);
    expect(runtime, "runtime").toBe(k.ok);
    for (const [variant, g, coerce] of VARIANTS) {
      const s =
        kind === "node"
          ? mode === "create"
            ? g.ZdUserCreateInputSchema
            : g.ZdUserUpdateInputSchema
          : mode === "create"
            ? g.ZdFollowsCreateInputSchema
            : g.ZdFollowsUpdateInputSchema;
      expect(s.safeParse(data).success, variant).toBe(expected(k, coerce));
    }
  });
});

describe("generated schemas", () => {
  it.each(VARIANTS)("%s: the model schema reads a stored node", (_v, g) => {
    const stored = {
      ...Object.fromEntries(
        user.fields.flatMap((f) => (f.kind === "scalar" ? [[f.name, f.list ? [] : null]] : [])),
      ),
      id: "u1",
      email: "ada@example.com",
      name: "Ada",
      role: "MEMBER",
      count: 0,
      score: 0,
      active: true,
      balance: 0n,
      seenAt: new Date("2025-01-01T00:00:00Z"),
      prefs: {},
      tags: ["a"],
      labels: ["x"],
    };
    expect(g.ZdUserSchema.safeParse(stored).success).toBe(true);
    expect(g.ZdUserSchema.safeParse({ ...stored, roles: null }).success).toBe(false);
    expect(g.ZdUserSchema.safeParse({ ...stored, nick: undefined }).success).toBe(false);
    expect(g.ZdUserSchema.safeParse({ ...stored, id: undefined }).success).toBe(false);
  });

  it.each(VARIANTS)("%s: messages follow the runtime's", (_v, g) => {
    const r = g.ZdUserCreateInputSchema.safeParse({ ...BASE, name: "A", age: 12 });
    expect(r.success).toBe(false);
    const messages = r.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    expect(messages).toEqual([
      "name: must be at least 2 characters long.",
      "age: must be at least 13.",
    ]);
  });

  it.each(VARIANTS.filter(([, , coerce]) => coerce))("%s: coerces API text", (_v, g) => {
    const r = g.ZdUserCreateInputSchema.parse({
      ...BASE,
      balance: "42",
      seenAt: "2025-01-01T00:00:00Z",
    });
    expect(r.balance).toBe(42n);
    expect(r.seenAt).toEqual(new Date("2025-01-01T00:00:00Z"));
  });

  it("strips unknown keys and relation fields", () => {
    const r = v4.ZdUserCreateInputSchema.parse({ ...BASE, follows: { connect: { id: "x" } } });
    expect(r).not.toHaveProperty("follows");
  });
});

// Type-level: what the schemas parse is accepted by the client's writes and matches its models.
type ZodDb = import("./__fixtures__/zod.gen.js").Db;
type ZdUser = import("./__fixtures__/zod.gen.js").ZdUser;
type ZdFollows = import("./__fixtures__/zod.gen.js").ZdFollows;
type CreateData = Parameters<ZodDb["zdUser"]["create"]>[0]["data"];
type UpdateData = Parameters<ZodDb["zdUser"]["update"]>[0]["data"];
type Parsed<S extends { parse(v: unknown): unknown }> = ReturnType<S["parse"]>;
export const typeChecks = [
  (d: Parsed<typeof v4.ZdUserCreateInputSchema>): CreateData => d,
  (d: Parsed<typeof v4Coerce.ZdUserCreateInputSchema>): CreateData => d,
  (d: Parsed<typeof v3.ZdUserCreateInputSchema>): CreateData => d,
  (d: Parsed<typeof v4.ZdUserUpdateInputSchema>): UpdateData => d,
  (d: Parsed<typeof v3Coerce.ZdUserUpdateInputSchema>): UpdateData => d,
  (d: Parsed<typeof v4.ZdUserSchema>): ZdUser => d,
  (d: Parsed<typeof v3.ZdUserSchema>): ZdUser => d,
  (d: Parsed<typeof v4.ZdFollowsSchema>): ZdFollows => d,
  (d: Parsed<typeof v4.ZdFollowsCreateInputSchema>): Partial<ZdFollows> => d,
];
