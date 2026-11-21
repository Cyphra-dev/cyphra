import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StudioApi } from "./api.js";
import { loadStaticDir, startStudioServer, type StudioServerOptions } from "./server.js";

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** Raw HTTP request (lets the test set any Host header, unlike fetch). */
function send(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const TOKEN = "test-token-0123456789";

describe("studio server", () => {
  let dir: string;
  let server: Server;
  let opts: StudioServerOptions;
  const seen: { method: string; path: string; body: unknown }[] = [];
  const api: StudioApi = {
    meta: {} as StudioApi["meta"],
    async handle(method, p, body) {
      seen.push({ method, path: p, body });
      return { status: 200, body: { ok: true, path: p } };
    },
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cyphra-studio-"));
    await writeFile(path.join(dir, "index.html"), "<!doctype html><title>Studio</title>");
    await writeFile(path.join(dir, "app.js"), "console.log(1)");
    await writeFile(path.join(dir, "app.js.map"), "{}");
    opts = { api, token: TOKEN, host: "127.0.0.1", port: 0, files: await loadStaticDir(dir) };
    server = await startStudioServer(opts);
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  const cookie = () => `cyphra_studio_${opts.port}=${TOKEN}`;
  const apiHeaders = () => ({ "x-cyphra-studio": "1", cookie: cookie() });

  it("serves the UI with security headers", async () => {
    const res = await send(opts.port, {});
    expect(res.status).toBe(200);
    expect(res.body).toContain("<title>Studio</title>");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect((await send(opts.port, { path: "/app.js" })).headers["content-type"]).toMatch(
      /javascript/,
    );
    // Only known files: no source maps, no path traversal.
    expect((await send(opts.port, { path: "/app.js.map" })).status).toBe(404);
    expect((await send(opts.port, { path: "/../package.json" })).status).toBe(404);
  });

  it("refuses foreign Host headers (DNS rebinding)", async () => {
    const res = await send(opts.port, { headers: { host: `attacker.example:${opts.port}` } });
    expect(res.status).toBe(403);
    const apiRes = await send(opts.port, {
      path: "/api/meta",
      headers: { ...apiHeaders(), host: `attacker.example:${opts.port}` },
    });
    expect(apiRes.status).toBe(403);
  });

  it("exchanges the URL token for an HttpOnly SameSite=Strict cookie", async () => {
    const res = await send(opts.port, { path: `/?token=${TOKEN}` });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
    expect(res.headers["set-cookie"]?.[0]).toBe(
      `cyphra_studio_${opts.port}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
    );
    expect((await send(opts.port, { path: "/?token=wrong" })).status).toBe(401);
  });

  it("requires the session cookie and the studio header on the API", async () => {
    seen.length = 0;
    expect((await send(opts.port, { path: "/api/meta" })).status).toBe(403);
    expect(
      (await send(opts.port, { path: "/api/meta", headers: { "x-cyphra-studio": "1" } })).status,
    ).toBe(401);
    expect(
      (
        await send(opts.port, {
          path: "/api/meta",
          headers: { "x-cyphra-studio": "1", cookie: `cyphra_studio_${opts.port}=nope` },
        })
      ).status,
    ).toBe(401);
    expect(seen).toEqual([]);
    const ok = await send(opts.port, { path: "/api/meta", headers: apiHeaders() });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true, path: "/api/meta" });
    expect(ok.headers["cache-control"]).toBe("no-store");
  });

  it("refuses cross-origin and non-JSON writes", async () => {
    const cross = await send(opts.port, {
      method: "POST",
      path: "/api/models/User/delete",
      headers: {
        ...apiHeaders(),
        origin: "http://attacker.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(cross.status).toBe(403);
    const form = await send(opts.port, {
      method: "POST",
      path: "/api/models/User/delete",
      headers: { ...apiHeaders(), "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(form.status).toBe(415);
    const bad = await send(opts.port, {
      method: "POST",
      path: "/api/cypher",
      headers: { ...apiHeaders(), "content-type": "application/json" },
      body: "{nope",
    });
    expect(bad.status).toBe(400);
    const good = await send(opts.port, {
      method: "POST",
      path: "/api/cypher",
      headers: {
        ...apiHeaders(),
        "content-type": "application/json",
        origin: `http://127.0.0.1:${opts.port}`,
      },
      body: JSON.stringify({ query: "RETURN 1" }),
    });
    expect(good.status).toBe(200);
    expect(seen.at(-1)).toEqual({
      method: "POST",
      path: "/api/cypher",
      body: { query: "RETURN 1" },
    });
  });

  it("limits the body size", async () => {
    const res = await send(opts.port, {
      method: "POST",
      path: "/api/cypher",
      headers: { ...apiHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ query: "x".repeat(1024 * 1024 + 10) }),
    }).catch(() => ({ status: 413 }) as Res);
    expect(res.status).toBe(413);
  });
});

const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/studio");

// The prebuilt UI (`pnpm --filter @cyphra/cli build`); CI builds the packages before testing.
describe.skipIf(!existsSync(BUNDLE))("studio bundle", () => {
  it("is served: index, script, styles and icon, without external URLs", async () => {
    const files = await loadStaticDir(BUNDLE);
    expect([...files.keys()].sort()).toEqual([
      "/app.css",
      "/app.js",
      "/icon.svg",
      "/index.html",
      "/theme.js",
    ]);
    const server = await startStudioServer({
      api: { meta: {} as StudioApi["meta"], handle: async () => ({ status: 200, body: {} }) },
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      files,
    }).then((s) => s);
    try {
      const port = (server.address() as { port: number }).port;
      const index = await send(port, {});
      expect(index.status).toBe(200);
      expect(index.body).toContain('<script src="/app.js"></script>');
      for (const p of ["/app.js", "/app.css", "/theme.js", "/icon.svg"]) {
        const res = await send(port, { path: p });
        expect(res.status, p).toBe(200);
        expect(res.body.length, p).toBeGreaterThan(50);
      }
      // No CDN at runtime: nothing is loaded from another origin.
      for (const f of files.values()) {
        expect(f.body.toString("utf8")).not.toMatch(/(src|href)=["']https?:/);
      }
      const total = [...files.values()].reduce((n, f) => n + f.body.length, 0);
      expect(total).toBeLessThan(150 * 1024);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
