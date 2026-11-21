import { parseSchema, resolveSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import type { DriverLike, TransactionLike } from "../client.js";
import type { CyphraEvent } from "../observability.js";
import { Neo4jHttpError } from "../http/driver.js";
import { createOrm } from "./client.js";
import { CyphraError, UniqueConstraintError } from "./errors.js";
import {
  CONSTRAINT_VALIDATION_FAILED,
  parseUniqueViolation,
  uniqueConstraintError,
} from "./unique.js";

const schema = resolveSchema(
  parseSchema(`
    interface Person {
      id    String @id @default(cuid())
      email String @unique
    }
    node Employee implements Person { badge String @unique }
    node Member {
      id       String @id @default(cuid())
      tenantId String
      email    String
      @@unique([tenantId, email])
    }
    node Slot {
      day  Int
      room String
      @@unique([day, room], name: "dayRoom")
    }
    node Tag {
      code    String @unique
      friends Tag[]  @relationship(type: "KNOWS", direction: OUT)
    }
    relationship Knows {
      type "KNOWS"
      from Tag
      to   Tag
      ref  String @unique
    }
  `),
);

/** A `Neo4jError` as neo4j-driver 5 / 6 raise it against Neo4j 5 (GQL status `50N42`). */
function boltError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), {
    name: "Neo4jError",
    code: CONSTRAINT_VALIDATION_FAILED,
    gqlStatus: "50N42",
    ...extra,
  });
}

describe("parseUniqueViolation", () => {
  it("reads a single-property node violation", () => {
    expect(
      parseUniqueViolation(
        "Node(12) already exists with label `User` and property `email` = 'a@example.com'",
      ),
    ).toEqual({ entity: "node", label: "User", properties: ["email"] });
  });

  it("reads a composite violation", () => {
    expect(
      parseUniqueViolation(
        "Node(1) already exists with label `Member` and properties `tenantId` = 't1', `email` = 'a@example.com'",
      ),
    ).toEqual({ entity: "node", label: "Member", properties: ["tenantId", "email"] });
  });

  it("reads a relationship violation", () => {
    expect(
      parseUniqueViolation("Relationship(0) already exists with type `KNOWS` and property `k` = 1"),
    ).toEqual({ entity: "relationship", label: "KNOWS", properties: ["k"] });
  });

  it("reads Neo4j 2025 causes (GQL prefix, trailing period) and element ids", () => {
    expect(
      parseUniqueViolation(
        "22N80: Index entry conflict: Node(0) already exists with label `User` and property `email` = 'x@example.com'.",
      ),
    ).toEqual({ entity: "node", label: "User", properties: ["email"] });
    expect(
      parseUniqueViolation(
        "Node('4:abc:7') already exists with label `User` and property `email` = 'x@example.com'",
      ),
    ).toMatchObject({ label: "User" });
  });

  it("unescapes backticks in labels and properties", () => {
    expect(
      parseUniqueViolation("Node(3) already exists with label `A``B` and property `c``d` = 1"),
    ).toEqual({ entity: "node", label: "A`B", properties: ["c`d"] });
  });

  it("returns undefined for other messages", () => {
    expect(
      parseUniqueViolation(
        "Cannot delete node<27>, because it still has relationships. To delete this node, you must first delete its relationships.",
      ),
    ).toBeUndefined();
  });
});

describe("uniqueConstraintError", () => {
  it("maps a @unique violation (neo4j-driver 5 / 6 on Neo4j 5)", () => {
    const cause = boltError(
      "Node(4) already exists with label `Employee` and property `badge` = 'b-1'",
    );
    const err = uniqueConstraintError(schema, cause)!;
    expect(err).toBeInstanceOf(UniqueConstraintError);
    expect(err).toBeInstanceOf(CyphraError);
    expect(err).toMatchObject({
      name: "UniqueConstraintError",
      model: "Employee",
      fields: ["badge"],
      constraint: "Employee_badge_unique",
      code: CONSTRAINT_VALIDATION_FAILED,
      gqlStatus: "50N42",
    });
    expect(err.cause).toBe(cause);
    expect(err.message).toBe(
      "Unique constraint failed on Employee(badge) (constraint Employee_badge_unique): a node with the same value already exists.",
    );
    // The duplicate value stays in the cause only.
    expect(err.message).not.toContain("b-1");
  });

  it("maps a Neo4j 2025 error (GQL 22N79 with a 22N80 cause)", () => {
    const message =
      "Node(0) already exists with label `Member` and properties `tenantId` = 't', `email` = 'x'";
    const cause = boltError(message, {
      gqlStatus: "22N79",
      cause: Object.assign(new Error(`22N80: Index entry conflict: ${message}.`), {
        gqlStatus: "22N80",
      }),
    });
    expect(uniqueConstraintError(schema, cause)).toMatchObject({
      model: "Member",
      fields: ["tenantId", "email"],
      constraint: "Member_tenantId_email_unique",
      gqlStatus: "22N79",
    });
  });

  it("finds the violation in a cause, or by its GQL status alone", () => {
    const inner = Object.assign(
      new Error("Node(0) already exists with label `Slot` and properties `day` = 1, `room` = 'a'"),
      { gqlStatus: "22N80" },
    );
    expect(uniqueConstraintError(schema, new Error("wrapped", { cause: inner }))).toMatchObject({
      model: "Slot",
      fields: ["day", "room"],
      constraint: "dayRoom",
      code: CONSTRAINT_VALIDATION_FAILED,
    });
    const opaque = Object.assign(new Error("Unexpected"), { gqlStatus: "22N79" });
    expect(uniqueConstraintError(schema, opaque)).toMatchObject({
      model: undefined,
      fields: [],
      constraint: undefined,
      message: "Unique constraint failed: Unexpected",
    });
  });

  it("has a readable message when the server sends a GQL status and no message", () => {
    for (const message of [undefined, "", "  "]) {
      const err = uniqueConstraintError(schema, { gqlStatus: "22N79", message });
      expect(err).toBeInstanceOf(UniqueConstraintError);
      expect(err!.message).toBe(
        "Unique constraint failed (GQL status 22N79): a node or relationship with the same value already exists.",
      );
      expect(err!.message).not.toContain("undefined");
      expect(err).toMatchObject({ model: undefined, fields: [], gqlStatus: "22N79" });
    }
  });

  it("maps an interface's constraint to the interface", () => {
    // `Employee implements Person`: email is constrained on :Person.
    const err = uniqueConstraintError(
      schema,
      boltError(
        "Node(9) already exists with label `Person` and property `email` = 'a@example.com'",
      ),
    );
    expect(err).toMatchObject({
      model: "Person",
      fields: ["email"],
      constraint: "Person_email_unique",
    });
  });

  it("maps @id and relationship @unique", () => {
    expect(
      uniqueConstraintError(
        schema,
        boltError("Node(1) already exists with label `Member` and property `id` = 'm1'"),
      ),
    ).toMatchObject({ model: "Member", fields: ["id"], constraint: "Member_id_id" });
    const rel = uniqueConstraintError(
      schema,
      boltError("Relationship(2) already exists with type `KNOWS` and property `ref` = 'r'"),
    )!;
    expect(rel).toMatchObject({
      model: "Knows",
      fields: ["ref"],
      constraint: "Knows_ref_rel_unique",
    });
    expect(rel.message).toContain("a relationship with the same value already exists");
  });

  it("ignores property names quoted inside string values", () => {
    const err = uniqueConstraintError(
      schema,
      boltError(
        "Node(1) already exists with label `Member` and properties `tenantId` = 'x, `role` = 1', `email` = 'e'",
      ),
    );
    expect(err).toMatchObject({
      fields: ["tenantId", "email"],
      constraint: "Member_tenantId_email_unique",
    });
  });

  it("keeps the label and properties of a constraint the schema does not declare", () => {
    expect(
      uniqueConstraintError(
        schema,
        boltError("Node(1) already exists with label `Legacy` and property `key` = 1"),
      ),
    ).toMatchObject({ model: undefined, fields: ["key"], constraint: undefined });
    // A label the schema has, a property it does not constrain (a constraint made outside Cyphra).
    expect(
      uniqueConstraintError(
        schema,
        boltError("Node(1) already exists with label `Member` and property `email` = 'e'"),
      ),
    ).toMatchObject({ model: "Member", fields: ["email"], constraint: undefined });
  });

  it("maps the HTTP transport's Neo4jHttpError", () => {
    const cause = new Neo4jHttpError(
      "Node(8) already exists with label `Person` and property `email` = 'x@example.com'",
      CONSTRAINT_VALIDATION_FAILED,
      400,
    );
    expect(uniqueConstraintError(schema, cause)).toMatchObject({
      model: "Person",
      fields: ["email"],
      code: CONSTRAINT_VALIDATION_FAILED,
      gqlStatus: undefined,
      cause,
    });
  });

  it("leaves other errors alone", () => {
    expect(
      uniqueConstraintError(
        schema,
        boltError("Cannot delete node<27>, because it still has relationships."),
      ),
    ).toBeUndefined();
    expect(
      uniqueConstraintError(
        schema,
        Object.assign(new Error("Invalid input"), {
          code: "Neo.ClientError.Statement.SyntaxError",
        }),
      ),
    ).toBeUndefined();
    expect(uniqueConstraintError(schema, "boom")).toBeUndefined();
    expect(uniqueConstraintError(schema, null)).toBeUndefined();
  });
});

describe("ORM client mapping", () => {
  const duplicate = () =>
    boltError("Node(1) already exists with label `Person` and property `email` = 'a@example.com'");

  /** A driver whose statements fail with `fail()` when their text matches `when`. */
  function failingDriver(when: RegExp, fail: () => unknown, onCommit = false): DriverLike {
    const run = async (text: string) => {
      if (!onCommit && when.test(text)) throw fail();
      return { records: [], summary: {} };
    };
    const tx: TransactionLike = { run };
    return {
      session: () => ({
        run,
        executeRead: async (work) => work(tx),
        executeWrite: async (work) => {
          const out = await work(tx);
          if (onCommit) throw fail();
          return out;
        },
        close: async () => {},
      }),
      close: async () => {},
    };
  }

  it("throws UniqueConstraintError from writes, $cypher and $transaction, after the Neo4j-coded error event", async () => {
    const db = createOrm(schema, { driver: failingDriver(/CREATE|SET/, duplicate) }) as never as {
      employee: { create(a: unknown): Promise<unknown> };
      $cypher(s: TemplateStringsArray, ...v: unknown[]): Promise<unknown>;
      $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
      $on(level: "error", l: (e: CyphraEvent) => void): () => void;
    };
    const events: CyphraEvent[] = [];
    db.$on("error", (e) => events.push(e));
    await expect(
      db.employee.create({ data: { email: "a@example.com", badge: "b" } }),
    ).rejects.toMatchObject({ name: "UniqueConstraintError", model: "Person", fields: ["email"] });
    expect(events[0]).toMatchObject({ code: CONSTRAINT_VALIDATION_FAILED });
    await expect(db.$cypher`CREATE (:Person {email: ${"a@example.com"}})`).rejects.toBeInstanceOf(
      UniqueConstraintError,
    );
    let inside: unknown;
    const outside = await db
      .$transaction(async (tx) => {
        try {
          await (tx as typeof db).employee.create({ data: { email: "a@example.com", badge: "b" } });
        } catch (e) {
          inside = e;
          throw e;
        }
      })
      .catch((e: unknown) => e);
    // Caught inside the transaction already mapped, and the same instance outside.
    expect(inside).toBeInstanceOf(UniqueConstraintError);
    expect(outside).toBe(inside);
  });

  it("hands query hooks the mapped error, which reaches the caller unchanged", async () => {
    const base = createOrm(schema, { driver: failingDriver(/CREATE/, duplicate) }) as never as {
      $extends(ext: unknown): { employee: { create(a: unknown): Promise<unknown> } };
    };
    const seen: unknown[] = [];
    const xdb = base.$extends({
      query: {
        $allModels: {
          async $allOperations({ args, query }: { args: unknown; query: (a: unknown) => unknown }) {
            try {
              return await query(args);
            } catch (e) {
              seen.push(e);
              throw e;
            }
          },
        },
      },
    });
    const err = await xdb.employee
      .create({ data: { email: "a@example.com", badge: "b" } })
      .catch((e: unknown) => e);
    expect(seen).toEqual([err]);
    expect(err).toBeInstanceOf(UniqueConstraintError);
  });

  it("maps a violation raised at commit", async () => {
    const db = createOrm(schema, { driver: failingDriver(/./, duplicate, true) }) as never as {
      $cypher(s: TemplateStringsArray, ...v: unknown[]): Promise<unknown>;
    };
    await expect(db.$cypher`RETURN 1`).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it("rethrows other errors unchanged", async () => {
    const boom = new Error("connection refused");
    const db = createOrm(schema, { driver: failingDriver(/./, () => boom) }) as never as {
      $cypher(s: TemplateStringsArray, ...v: unknown[]): Promise<unknown>;
    };
    await expect(db.$cypher`RETURN 1`).rejects.toBe(boom);
  });
});
