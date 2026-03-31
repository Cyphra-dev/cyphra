import neo4j, { type Config, type Driver } from "neo4j-driver";

/** Options when CyphraNeo4j creates and owns the Bolt driver. */
export type CyphraNeo4jConnectOptions = {
  readonly uri?: string;
  /** Alias of {@link uri} (Prisma-style `url`). */
  readonly url?: string;
  readonly user: string;
  readonly password: string;
  /** Neo4j 4+ database name. */
  readonly database?: string;
  /** Third argument to `neo4j.driver`. */
  readonly driverConfig?: Config;
};

/** Options when reusing an existing driver (caller owns lifecycle unless {@link CyphraNeo4j.close} is used). */
export type CyphraNeo4jDriverOptions = {
  readonly driver: Driver;
  readonly database?: string;
};

export type CyphraNeo4jOptions = CyphraNeo4jConnectOptions | CyphraNeo4jDriverOptions;

function isDriverOpts(o: CyphraNeo4jOptions): o is CyphraNeo4jDriverOptions {
  return "driver" in o && o.driver != null;
}

/**
 * Neo4j Bolt adapter for {@link CyphraClient} (Prisma-style `driver adapters` DX).
 *
 * Either pass connection fields (Cyphra owns the driver and closes it with the client)
 * or inject a {@link Driver} you manage yourself (`ownDriver: false`).
 */
export class CyphraNeo4j {
  readonly driver: Driver;
  readonly database: string | undefined;
  /** When true, {@link CyphraNeo4j.dispose} closes the underlying driver. */
  readonly ownDriver: boolean;

  constructor(opts: CyphraNeo4jOptions) {
    if (isDriverOpts(opts)) {
      this.driver = opts.driver;
      this.database = opts.database;
      this.ownDriver = false;
    } else {
      const uri = opts.uri ?? opts.url;
      if (uri === undefined || uri === "") {
        throw new Error("CyphraNeo4j: provide uri or url for the Bolt connection string");
      }
      this.driver = neo4j.driver(
        uri,
        neo4j.auth.basic(opts.user, opts.password),
        opts.driverConfig,
      );
      this.database = opts.database;
      this.ownDriver = true;
    }
  }

  /** Close the driver only if this adapter created it. */
  async dispose(): Promise<void> {
    if (this.ownDriver) {
      await this.driver.close();
    }
  }
}
