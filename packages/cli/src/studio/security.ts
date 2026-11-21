import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { STUDIO_HEADER } from "./protocol.js";

/** A random per-session token (192 bits, URL-safe). */
export function createToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Constant-time comparison of two tokens. */
export function tokensEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `true` for `localhost`, `127.0.0.0/8` and `::1`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  return h === "::1";
}

/** Host name of a `Host` header value (`127.0.0.1:5555` → `127.0.0.1`, `[::1]:5555` → `::1`). */
export function hostnameOf(hostHeader: string): string {
  const v = hostHeader.trim().toLowerCase();
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    return end === -1 ? v : v.slice(1, end);
  }
  const colon = v.lastIndexOf(":");
  return colon === -1 ? v : v.slice(0, colon);
}

function portOf(hostHeader: string): string | undefined {
  const v = hostHeader.trim();
  const m = /:(\d+)$/.exec(v.startsWith("[") ? v.slice(v.indexOf("]")) : v);
  return m?.[1];
}

/**
 * DNS rebinding guard: the `Host` header must name this server by an IP literal or
 * `localhost`, on its port. A rebinding attack reaches the server under the attacker's domain
 * name, which is refused (the explicit `--host` name is allowed too).
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  port: number,
  bindHost: string,
): boolean {
  if (!hostHeader) return false;
  if (portOf(hostHeader) !== String(port)) return false;
  const name = hostnameOf(hostHeader);
  if (name === "localhost" || isIP(name) !== 0) return true;
  return name === bindHost.toLowerCase();
}

/**
 * Cross-origin guard: a request carrying an `Origin` must come from the studio page itself
 * (same scheme, host and port as the `Host` it was sent to).
 */
export function isAllowedOrigin(origin: string | undefined, hostHeader: string): boolean {
  if (origin === undefined) return true;
  return origin.toLowerCase() === `http://${hostHeader.trim().toLowerCase()}`;
}

/** Name of the session cookie (per port: cookies are not isolated by port). */
export function cookieName(port: number): string {
  return `cyphra_studio_${port}`;
}

/** Value of cookie `name` in a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export type GuardResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Checks of every API request: allowed `Host` and `Origin`, the session cookie, and the
 * studio header (which a cross-site form or `fetch` without CORS cannot add).
 */
export function checkApiRequest(
  req: Pick<IncomingMessage, "headers" | "method">,
  opts: { token: string; port: number; host: string },
): GuardResult {
  const host = req.headers.host;
  if (!isAllowedHost(host, opts.port, opts.host)) {
    return { ok: false, status: 403, error: "Host not allowed." };
  }
  if (!isAllowedOrigin(req.headers.origin, host!)) {
    return { ok: false, status: 403, error: "Cross-origin request refused." };
  }
  if (req.headers[STUDIO_HEADER] !== "1") {
    return { ok: false, status: 403, error: `Missing ${STUDIO_HEADER} header.` };
  }
  const token = readCookie(req.headers.cookie, cookieName(opts.port));
  if (!tokensEqual(token, opts.token)) {
    return {
      ok: false,
      status: 401,
      error: "Missing or invalid session token: open the URL printed by `cyphra studio`.",
    };
  }
  return { ok: true };
}

/** A connection URI without user info, query or fragment (`bolt://u:p@h:7687?x` → `bolt://h:7687`). */
export function redactUri(uri: string | undefined): string {
  if (!uri) return "";
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return "(unparsable URI)";
  }
}
