import { TRPCClientError } from "@trpc/client";
import { CyphraValidationError, NotFoundError } from "cyphra";
import { describe, expect, it } from "vitest";
import type { Db } from "./cyphra.gen";
import { httpClient } from "./http-client";
import { appRouter, type AppRouter } from "./router";
import { publicProcedure, router } from "./trpc";

// Input that zod rejects never reaches the database: a client that throws on any use proves it.
const noDb = new Proxy({} as Db, {
  get: () => {
    throw new Error("the database was used");
  },
});

async function rejection(promise: Promise<unknown>): Promise<TRPCClientError<AppRouter>> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof TRPCClientError) return e as TRPCClientError<AppRouter>;
    throw e;
  }
  throw new Error("expected the call to fail");
}

describe("error mapping", () => {
  it("rejects input that breaks the schema's rules with 400 and the issues", async () => {
    const client = httpClient(appRouter, { db: noDb });
    const error = await rejection(
      client.post.create.mutate({
        authorId: "u1",
        title: "Hi",
        body: "",
        tags: ["a", "b", "c", "d", "e", "f"],
      }),
    );
    expect(error.data?.code).toBe("BAD_REQUEST");
    expect(error.data?.httpStatus).toBe(400);
    expect(error.message).toBe("Invalid input.");
    expect(error.data?.issues).toEqual([
      { path: ["title"], message: "must be at least 3 characters long." },
      { path: ["tags"], message: "must have at most 5 elements." },
    ]);
  });

  it("rejects an unknown enum value", async () => {
    const client = httpClient(appRouter, { db: noDb });
    const error = await rejection(
      // @ts-expect-error: "LIVE" is not a PostStatus
      client.post.update.mutate({ id: "p1", data: { status: "LIVE" } }),
    );
    expect(error.data?.code).toBe("BAD_REQUEST");
    expect(error.data?.issues?.[0]?.path).toEqual(["data", "status"]);
  });

  it("maps the client's errors: CyphraValidationError, NotFoundError, constraint failures", async () => {
    const issue = {
      path: ["data", "title"],
      model: "Post",
      field: "title",
      rule: "length",
      message: "must be at least 3 characters long (got 2).",
    } as const;
    const failing = router({
      invalid: publicProcedure.mutation(() => {
        throw new CyphraValidationError("Invalid Post data.", [issue]);
      }),
      missing: publicProcedure.query(() => {
        throw new NotFoundError("No Post matches {}.");
      }),
      duplicate: publicProcedure.mutation(() => {
        throw Object.assign(new Error("already exists with label `User`"), {
          code: "Neo.ClientError.Schema.ConstraintValidationFailed",
        });
      }),
      broken: publicProcedure.query(() => {
        throw new Error("connection refused");
      }),
    });
    const client = httpClient(failing, { db: noDb });

    const invalid = await rejection(client.invalid.mutate());
    expect(invalid.data).toMatchObject({ code: "BAD_REQUEST", httpStatus: 400 });
    expect(invalid.data?.issues).toEqual([{ path: ["data", "title"], message: issue.message }]);

    const missing = await rejection(client.missing.query());
    expect(missing.data).toMatchObject({ code: "NOT_FOUND", httpStatus: 404, issues: null });
    expect(missing.message).toBe("No Post matches {}.");

    const duplicate = await rejection(client.duplicate.mutate());
    expect(duplicate.data).toMatchObject({ code: "CONFLICT", httpStatus: 409 });
    expect(duplicate.message).toBe("Already exists.");

    const broken = await rejection(client.broken.query());
    expect(broken.data).toMatchObject({ code: "INTERNAL_SERVER_ERROR", httpStatus: 500 });
  });
});
