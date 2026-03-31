import { loadConfigSync } from "@cyphra/config";
import { createSchemaClient, type CyphraSchemaClient } from "@cyphra/orm";
import type { CompiledCypher } from "@cyphra/query";
import { parseSchema, validateSchema } from "@cyphra/schema";
import { CyphraClient as RuntimeCyphraClient, type CyphraClientOptions } from "@cyphra/runtime";
import { readFileSync } from "node:fs";
import { createFluentQueryRoot, type FluentQueryRoot } from "@cyphra/query";

/**
 * Options for {@link CyphraClient} when imported from **`cyphra`** (includes ORM wiring).
 */
export type CyphraAppClientOptions = CyphraClientOptions & {
  /**
   * Project root used to find `cyphra.config.*` / `cyphra.json` for {@link CyphraClient.orm}.
   * @defaultValue `process.cwd()`
   */
  readonly projectRoot?: string;
};

/**
 * Neo4j client when imported from **`cyphra`**: same Bolt surface as {@link RuntimeCyphraClient} plus a lazy {@link orm} delegate built from your `.cyphra` schema (via project config).
 *
 * For a headless Bolt client without ORM, import {@link RuntimeCyphraClient} from **`@cyphra/runtime`** instead.
 */
export class CyphraClient extends RuntimeCyphraClient {
  private readonly projectRoot: string;
  private _orm: CyphraSchemaClient | undefined;
  private _fluentQuery: FluentQueryRoot | undefined;

  constructor(opts: CyphraAppClientOptions) {
    const { projectRoot, ...rest } = opts;
    super(rest);
    this.projectRoot = projectRoot ?? process.cwd();
  }

  /**
   * Chaîne de lecture fluent : `cyphra.query.match((p) => p.label("Post").prop("slug").eq(slug)).optionalOut(...).return("p").limit(1).first()`.
   * Distinct du namespace statique **`import { query } from "cyphra"`** (`query.select`, `query.cypher`, …).
   */
  get query(): FluentQueryRoot {
    if (this._fluentQuery === undefined) {
      this._fluentQuery = createFluentQueryRoot(this);
    }
    return this._fluentQuery;
  }

  /**
   * Prisma-style schema client (`posts.create`, `findMany`, …). Loaded once from `schema` in `cyphra.config.*`.
   * Requires Node (filesystem); do not use in edge bundles that exclude `fs`.
   */
  get orm(): CyphraSchemaClient {
    if (this._orm === undefined) {
      const cfg = loadConfigSync(this.projectRoot);
      const src = readFileSync(cfg.schema, "utf8");
      const doc = parseSchema(src);
      validateSchema(doc);
      this._orm = createSchemaClient(this, doc);
    }
    return this._orm;
  }

  /**
   * Run a read-only compiled query (Bolt **READ** session) and return plain records.
   * Sugar over `withSession` + `queryRecords` for app code.
   */
  async readQuery(compiled: CompiledCypher): Promise<Record<string, unknown>[]> {
    const session = this.sessionRead();
    try {
      return await this.queryRecords(session, compiled);
    } finally {
      await session.close();
    }
  }
}
