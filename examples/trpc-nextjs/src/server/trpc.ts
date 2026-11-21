import { initTRPC, TRPCError } from "@trpc/server";
import { CyphraValidationError, NotFoundError, RestrictError } from "cyphra";
import superjson from "superjson";
import { ZodError } from "zod";
import type { Db } from "./cyphra.gen";

/** What every procedure gets in `ctx`. The route handler and the tests build it. */
export type Context = { db: Db };

/** One invalid input value, from zod (`.input()`) or from the Cyphra client (`issues`). */
export type InputIssue = { path: (string | number)[]; message: string };

function inputIssues(cause: unknown): InputIssue[] | null {
  if (cause instanceof ZodError) {
    return cause.issues.map((i) => ({
      path: i.path.map((p) => (typeof p === "number" ? p : String(p))),
      message: i.message,
    }));
  }
  if (cause instanceof CyphraValidationError) {
    return cause.issues.map((i) => ({ path: [...i.path], message: i.message }));
  }
  return null;
}

const t = initTRPC.context<Context>().create({
  // Dates (createdAt) reach the browser as Date objects, as the types say.
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const issues = error.code === "BAD_REQUEST" ? inputIssues(error.cause) : null;
    return {
      ...shape,
      // zod's own message is its issues as JSON: `issues` carries them, readable.
      message: error.cause instanceof ZodError ? "Invalid input." : shape.message,
      data: { ...shape.data, issues },
    };
  },
});

/** Neo4j's error code for a write that breaks a uniqueness constraint (`@unique`, `@id`). */
const CONSTRAINT_FAILED = "Neo.ClientError.Schema.ConstraintValidationFailed";

/** Turn the Cyphra client's errors into tRPC errors with the matching HTTP status. */
export function toTRPCError(cause: unknown): TRPCError | null {
  if (cause instanceof CyphraValidationError) {
    return new TRPCError({ code: "BAD_REQUEST", message: cause.message, cause });
  }
  if (cause instanceof NotFoundError) {
    return new TRPCError({ code: "NOT_FOUND", message: cause.message, cause });
  }
  if (cause instanceof RestrictError) {
    return new TRPCError({ code: "CONFLICT", message: cause.message, cause });
  }
  if ((cause as { code?: unknown } | null)?.code === CONSTRAINT_FAILED) {
    return new TRPCError({ code: "CONFLICT", message: "Already exists.", cause: cause as Error });
  }
  return null;
}

const cyphraErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const mapped = toTRPCError(result.error.cause);
    if (mapped) throw mapped;
  }
  return result;
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure.use(cyphraErrors);
