import { describe, expect, it } from "vitest";
import type { CleanedWhere } from "better-auth/adapters";
import { authSchema } from "./index.js";
import { toCyphraWhere } from "./where.js";

const graph = authSchema({});
const session = graph.models.get("session")!;
const user = graph.models.get("user")!;
const parentOf = (key: string) => graph.models.get(key)!;

const w = (field: string, value: CleanedWhere["value"], extra: Partial<CleanedWhere> = {}) =>
  ({ field, value, operator: "eq", connector: "AND", mode: "sensitive", ...extra }) as CleanedWhere;

describe("toCyphraWhere", () => {
  it("translates foreign-key clauses into relation filters on the referenced field", () => {
    expect(toCyphraWhere(session, [w("userId", "u1")], parentOf)).toEqual({
      AND: [{ user: { is: { id: { equals: "u1" } } } }],
    });
    expect(toCyphraWhere(session, [w("userId", "u1", { operator: "ne" })], parentOf)).toEqual({
      AND: [{ user: { is: { id: { not: "u1" } } } }],
    });
    expect(
      toCyphraWhere(session, [w("userId", ["u1", "u2"], { operator: "in" })], parentOf),
    ).toEqual({ AND: [{ user: { is: { id: { in: ["u1", "u2"] } } } }] });
    expect(toCyphraWhere(session, [w("userId", null)], parentOf)).toEqual({
      AND: [{ user: null }],
    });
    expect(toCyphraWhere(session, [w("userId", null, { operator: "ne" })], parentOf)).toEqual({
      AND: [{ user: { isNot: null } }],
    });
  });

  it("groups AND clauses and OR clauses like Better Auth's SQL adapters", () => {
    expect(
      toCyphraWhere(
        user,
        [
          w("emailVerified", true),
          w("email", "a@x.io", { connector: "OR" }),
          w("name", "A", { connector: "OR", operator: "starts_with" }),
        ],
        parentOf,
      ),
    ).toEqual({
      AND: [{ emailVerified: { equals: true } }],
      OR: [{ email: { equals: "a@x.io" } }, { name: { startsWith: "A" } }],
    });
  });

  it("passes mode: insensitive for string values only, and drops nulls from in / not_in", () => {
    expect(toCyphraWhere(user, [w("email", "A@X.io", { mode: "insensitive" })], parentOf)).toEqual({
      AND: [{ email: { equals: "A@X.io", mode: "insensitive" } }],
    });
    expect(
      toCyphraWhere(user, [w("emailVerified", true, { mode: "insensitive" })], parentOf),
    ).toEqual({ AND: [{ emailVerified: { equals: true } }] });
    expect(
      toCyphraWhere(user, [w("name", ["a", null] as never, { operator: "in" })], parentOf),
    ).toEqual({ AND: [{ name: { in: ["a"] } }] });
    // An empty not_in matches everything.
    expect(toCyphraWhere(user, [w("name", [], { operator: "not_in" })], parentOf)).toEqual({
      AND: [{}],
    });
  });

  it("rejects unknown fields", () => {
    expect(() => toCyphraWhere(user, [w("nope", 1)], parentOf)).toThrow(/unknown field/);
  });
});
