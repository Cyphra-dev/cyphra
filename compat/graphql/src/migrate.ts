/**
 * The migration check of the suite (#249): every v7 operation of the fixtures goes through the
 * codemod (`migrate.translateDocument`); a translated one runs against `compat.v7` and against the
 * native API generated from the same type definitions (`cyphra import graphql`'s conversion, every
 * operation on), each on a freshly seeded database, and the v7 result, mapped to the native shape,
 * must equal the native one (`migrate.compareResults`). What the codemod cannot translate is
 * counted, not run.
 */
import {
  compat,
  migrate,
  native,
  type DocumentStatus,
  type DocumentTranslation,
  type GraphQLConfig,
  type GraphQLResultLike,
  type MigrationContext,
  type ResultDifference,
} from "@cyphra/graphql";
import { createOrm } from "@cyphra/runtime";
import { execute, parse, validate, type ExecutionResult, type GraphQLSchema } from "graphql";
import type { Driver } from "neo4j-driver";
import ts from "typescript";
import type { Fixture, Operation } from "./fixtures.js";
import { JWT_KEY, operationContext } from "./implementations.js";
import { normalizeResult } from "./normalize.js";
import { resetAndSeed } from "./runner.js";
import { loadResolvers } from "./fixtures.js";

/** What happened to one operation. */
export type MigrateOutcome = {
  fixture: string;
  operation: string;
  status: DocumentStatus | "same" | "known" | "differs" | "skipped";
  differences: ResultDifference[];
  reason?: string;
};

/** The migration context of a fixture (`undefined` when its type definitions cannot be served). */
export function fixtureContext(fixture: Fixture): MigrationContext | undefined {
  try {
    return migrate.createMigrationContext({ typeDefs: fixture.typeDefs });
  } catch {
    return undefined;
  }
}

/** The codemod's verdict on each operation of a fixture, without a database. */
export function translateFixture(
  fixture: Fixture,
  ctx: MigrationContext,
): { op: Operation; translation: DocumentTranslation }[] {
  return fixture.operations.map((op) => ({
    op,
    translation: migrate.translateDocument(ctx, op.document, { comments: false }),
  }));
}

/**
 * The `models` of the rules `migrate.draftRules` drafts for the fixture's `@authorization` /
 * `@authentication`, evaluated as the module it prints (with `defineGraphQL` as the identity).
 */
export async function draftedModels(ctx: MigrationContext): Promise<Record<string, unknown>> {
  const code = migrate
    .draftRules(ctx)
    .code.replace(
      /^import \{ defineGraphQL \} from "@cyphra\/graphql";$/m,
      "const defineGraphQL = (c) => c;",
    );
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = (await import(`data:text/javascript,${encodeURIComponent(js)}`)) as {
    default: { models: Record<string, unknown> };
  };
  return mod.default.models;
}

async function nativeContext(op: Operation): Promise<Record<string, unknown>> {
  const { token, ...context } = await operationContext(op);
  if (typeof token !== "string") return context;
  return {
    ...context,
    ...(await native.jwtContext({ key: JWT_KEY })({ req: { headers: { authorization: token } } })),
  };
}

async function run(
  schema: GraphQLSchema,
  source: string,
  op: Operation,
  context: Record<string, unknown>,
): Promise<ExecutionResult> {
  const document = parse(source);
  const errors = validate(schema, document);
  if (errors.length) return { errors };
  const r = await execute({
    schema,
    document,
    variableValues: op.variables,
    contextValue: context,
  });
  return JSON.parse(JSON.stringify(r)) as ExecutionResult;
}

/** Runs every translated operation of a fixture on both APIs and compares the results. */
export async function dualRunFixture(fixture: Fixture, driver: Driver): Promise<MigrateOutcome[]> {
  const ctx = fixtureContext(fixture);
  if (!ctx) return [];
  const v7 = compat.v7.makeSchema({
    typeDefs: fixture.typeDefs,
    driver,
    resolvers: await loadResolvers(fixture),
    features: { authorization: { key: JWT_KEY } },
  });
  const api = native.makeSchema({
    client: createOrm(ctx.model, { driver }),
    config: { ...ctx.config, models: (await draftedModels(ctx)) as GraphQLConfig["models"] },
  });
  const out: MigrateOutcome[] = [];
  for (const { op, translation } of translateFixture(fixture, ctx)) {
    const base = { fixture: fixture.name, operation: op.name, differences: [] };
    if (translation.status !== "translated") {
      out.push({ ...base, status: translation.status, reason: translation.issues[0]?.message });
      continue;
    }
    if (op.kind === "subscription") {
      out.push({ ...base, status: "skipped", reason: "subscription" });
      continue;
    }
    if (op.context && "sessionConfig" in op.context) {
      // Not in the document: the native API has no per-request session config.
      out.push({ ...base, status: "skipped", reason: "context.sessionConfig" });
      continue;
    }
    const def = translation.definitions.find((d) => d.kind === "operation")!;
    await resetAndSeed(driver, fixture.seed);
    const v7Result = normalizeResult(await run(v7, op.document, op, await operationContext(op)), {
      ordered: op.ordered,
    });
    await resetAndSeed(driver, fixture.seed);
    const nativeResult = normalizeResult(
      await run(api, translation.output, op, await nativeContext(op)),
      {
        ordered: op.ordered,
      },
    );
    const differences = migrate.compareResults(
      def,
      v7Result as GraphQLResultLike,
      nativeResult as GraphQLResultLike,
      { ordered: op.ordered },
    );
    const failing = differences.filter((d) => !d.known);
    out.push({
      ...base,
      status: failing.length ? "differs" : differences.length ? "known" : "same",
      differences,
    });
  }
  return out;
}
