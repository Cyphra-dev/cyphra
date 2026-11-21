import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { StudioApi } from "./api.js";
import {
  checkApiRequest,
  cookieName,
  isAllowedHost,
  isAllowedOrigin,
  tokensEqual,
} from "./security.js";

/** Largest JSON body the API accepts. */
export const MAX_BODY_BYTES = 1024 * 1024;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export type StaticFile = { readonly body: Buffer; readonly type: string };

/** Load the files of the prebuilt UI (flat directory) into memory. */
export async function loadStaticDir(dir: string): Promise<Map<string, StaticFile>> {
  const files = new Map<string, StaticFile>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    throw new Error(
      `The studio UI is missing (${dir}). Rebuild @cyphra/cli (pnpm --filter @cyphra/cli build).`,
    );
  }
  for (const name of names) {
    const type = TYPES[path.extname(name)];
    if (!type || name.endsWith(".map")) continue;
    files.set(`/${name}`, { body: await readFile(path.join(dir, name)), type });
  }
  if (!files.has("/index.html")) throw new Error(`The studio UI has no index.html (${dir}).`);
  return files;
}

export type StudioServerOptions = {
  readonly api: StudioApi;
  readonly token: string;
  readonly host: string;
  /** Port the server listens on (`0` until {@link startStudioServer} knows the real one). */
  port: number;
  readonly files: Map<string, StaticFile>;
};

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  type: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The request handler of the studio: static UI, the session-token handshake (`/?token=…` sets
 * an HttpOnly, SameSite=Strict cookie and redirects to `/`), and the JSON API under `/api/`.
 */
export function createStudioHandler(opts: StudioServerOptions) {
  const { api, token, host, files } = opts;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const port = opts.port;
    const cookie = cookieName(port);
    try {
      if (!isAllowedHost(req.headers.host, port, host)) {
        send(res, 403, "Host not allowed.", "text/plain; charset=utf-8");
        return;
      }
      const url = new URL(req.url ?? "/", "http://studio.invalid");
      if (url.pathname.startsWith("/api/")) {
        const guard = checkApiRequest(req, { token, port, host });
        if (!guard.ok) {
          sendJson(res, guard.status, { error: guard.error });
          return;
        }
        let body: unknown;
        if (req.method === "POST") {
          const type = req.headers["content-type"] ?? "";
          if (!type.toLowerCase().startsWith("application/json")) {
            sendJson(res, 415, { error: "Expected application/json." });
            return;
          }
          const text = await readBody(req);
          try {
            body = text ? JSON.parse(text) : {};
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body." });
            return;
          }
        } else if (req.method !== "GET") {
          sendJson(res, 405, { error: "Method not allowed." });
          return;
        }
        const out = await api.handle(req.method, url.pathname, body);
        sendJson(res, out.status, out.body);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        send(res, 405, "Method not allowed.", "text/plain; charset=utf-8");
        return;
      }
      if (!isAllowedOrigin(req.headers.origin, req.headers.host!)) {
        send(res, 403, "Cross-origin request refused.", "text/plain; charset=utf-8");
        return;
      }
      if (url.pathname === "/" && url.searchParams.has("token")) {
        if (!tokensEqual(url.searchParams.get("token") ?? undefined, token)) {
          send(res, 401, "Invalid studio token.", "text/plain; charset=utf-8");
          return;
        }
        // Move the token from the URL (history, screenshots) into an HttpOnly cookie.
        send(res, 302, "", "text/plain; charset=utf-8", {
          Location: "/",
          "Set-Cookie": `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
        return;
      }
      const file = files.get(url.pathname === "/" ? "/index.html" : url.pathname);
      if (!file) {
        send(res, 404, "Not found.", "text/plain; charset=utf-8");
        return;
      }
      send(res, 200, file.body, file.type);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (!res.headersSent) sendJson(res, status, { error: (e as Error).message });
      else res.destroy();
    }
  };
}

/** Start the studio HTTP server; resolves once it listens. */
export function startStudioServer(opts: StudioServerOptions): Promise<Server> {
  const handler = createStudioHandler(opts);
  const server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      const addr = server.address();
      if (addr && typeof addr === "object") opts.port = addr.port;
      resolve(server);
    });
  });
}
