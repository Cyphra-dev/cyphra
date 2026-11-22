import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOrm } from "@cyphra/runtime";
import { parseSchemaFile, resolveSchema } from "@cyphra/schema";
import { clientForConfig } from "../clientFromEnv.js";
import type { CyphraConfig } from "../config.js";
import { createStudioApi } from "../studio/api.js";
import { createStudioDb } from "../studio/db.js";
import { createToken, isLoopbackHost, redactUri } from "../studio/security.js";
import { loadStaticDir, startStudioServer } from "../studio/server.js";
import { buildMeta } from "../studio/values.js";

export type StudioOptions = {
  readonly port?: number;
  readonly host?: string;
  /** `false` with `--no-open`. */
  readonly open?: boolean;
  readonly readOnly?: boolean;
};

export const DEFAULT_STUDIO_PORT = 5555;
export const DEFAULT_STUDIO_HOST = "127.0.0.1";

/** Directory of the prebuilt UI: `dist/studio/` next to the bundled `dist/index.js`. */
function staticDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "studio");
}

/** Open `url` in the default browser (best effort, never throws). */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser: the URL is printed anyway
  }
}

/**
 * `cyphra studio`: serve a local data browser for the schema's models, backed by the ORM.
 * Resolves once the server listens; it runs until the process is stopped.
 */
export async function runStudio(
  config: CyphraConfig,
  opts: StudioOptions,
  version: string,
): Promise<{ url: string; close(): Promise<void> }> {
  const host = opts.host ?? DEFAULT_STUDIO_HOST;
  const port = opts.port ?? DEFAULT_STUDIO_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be a port number (got ${String(opts.port)}).`);
  }
  if (!isLoopbackHost(host)) {
    console.warn(
      `Warning: binding the studio to ${host}, which is not a loopback address. Anyone who can reach it and has the token can read${opts.readOnly ? "" : " and change"} your database.`,
    );
  }
  const schema = resolveSchema(await parseSchemaFile(config.schema));
  const files = await loadStaticDir(staticDir());
  // The dialect of cyphra.json, else the one the server announces (Memgraph or Neo4j).
  const client = await clientForConfig(config);
  const orm = createOrm(schema, { client }) as unknown as Record<string, unknown>;
  const readOnly = opts.readOnly === true;
  const meta = buildMeta(schema, {
    readOnly,
    connection: redactUri(process.env.NEO4J_URI),
    ...(process.env.NEO4J_DATABASE ? { database: process.env.NEO4J_DATABASE } : {}),
    version,
    dialect: client.dialect,
  });
  const api = createStudioApi({ schema, db: createStudioDb(orm, client), meta, readOnly });
  const token = createToken();
  const server = await startStudioServer({ api, token, host, port, files }).catch(
    async (e: NodeJS.ErrnoException) => {
      await client.close();
      if (e.code === "EADDRINUSE") {
        throw new Error(`Port ${port} is in use: pick another one with --port.`);
      }
      throw e;
    },
  );
  const addr = server.address();
  const realPort = addr && typeof addr === "object" ? addr.port : port;
  const shownHost = host.includes(":") ? `[${host}]` : host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `http://${shownHost}:${realPort}/?token=${token}`;
  console.log(
    `Cyphra Studio${readOnly ? " (read-only)" : ""}${client.dialect === "memgraph" ? " (Memgraph)" : ""} on ${url}`,
  );
  console.log("The token in the URL is required: keep it private. Stop with Ctrl+C.");
  if (opts.open !== false) openBrowser(url);
  const close = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await client.close();
  };
  return { url, close };
}
