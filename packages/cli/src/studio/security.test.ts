import { describe, expect, it } from "vitest";
import {
  checkApiRequest,
  cookieName,
  createToken,
  hostnameOf,
  isAllowedHost,
  isAllowedOrigin,
  isLoopbackHost,
  readCookie,
  redactUri,
  tokensEqual,
} from "./security.js";

describe("studio security", () => {
  it("creates distinct URL-safe tokens", () => {
    const a = createToken();
    const b = createToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("compares tokens", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abd", "abc")).toBe(false);
    expect(tokensEqual("ab", "abc")).toBe(false);
    expect(tokensEqual(undefined, "abc")).toBe(false);
  });

  it("recognises loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });

  it("parses Host headers", () => {
    expect(hostnameOf("127.0.0.1:5555")).toBe("127.0.0.1");
    expect(hostnameOf("[::1]:5555")).toBe("::1");
    expect(hostnameOf("LocalHost")).toBe("localhost");
  });

  it("allows IP literals and localhost on the server's port only (DNS rebinding)", () => {
    expect(isAllowedHost("127.0.0.1:5555", 5555, "127.0.0.1")).toBe(true);
    expect(isAllowedHost("localhost:5555", 5555, "127.0.0.1")).toBe(true);
    expect(isAllowedHost("[::1]:5555", 5555, "::1")).toBe(true);
    expect(isAllowedHost("127.0.0.1:5556", 5555, "127.0.0.1")).toBe(false);
    expect(isAllowedHost("127.0.0.1", 5555, "127.0.0.1")).toBe(false);
    expect(isAllowedHost("evil.example:5555", 5555, "127.0.0.1")).toBe(false);
    expect(isAllowedHost(undefined, 5555, "127.0.0.1")).toBe(false);
    // An explicit --host name is allowed.
    expect(isAllowedHost("devbox.lan:5555", 5555, "devbox.lan")).toBe(true);
  });

  it("allows only same-origin requests", () => {
    expect(isAllowedOrigin(undefined, "127.0.0.1:5555")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5555", "127.0.0.1:5555")).toBe(true);
    expect(isAllowedOrigin("http://evil.example", "127.0.0.1:5555")).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:3000", "127.0.0.1:5555")).toBe(false);
    expect(isAllowedOrigin("null", "127.0.0.1:5555")).toBe(false);
  });

  it("reads cookies", () => {
    expect(readCookie("a=1; cyphra_studio_5555=tok; b=2", cookieName(5555))).toBe("tok");
    expect(readCookie("a=1", cookieName(5555))).toBeUndefined();
    expect(readCookie(undefined, "x")).toBeUndefined();
  });

  it("checks every API request: host, origin, studio header, session cookie", () => {
    const opts = { token: "t0k", port: 5555, host: "127.0.0.1" };
    const good = {
      host: "127.0.0.1:5555",
      "x-cyphra-studio": "1",
      cookie: "cyphra_studio_5555=t0k",
    };
    expect(checkApiRequest({ headers: good, method: "GET" }, opts)).toEqual({ ok: true });
    expect(
      checkApiRequest({ headers: { ...good, host: "evil.example:5555" }, method: "GET" }, opts),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      checkApiRequest(
        { headers: { ...good, origin: "http://evil.example" }, method: "POST" },
        opts,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      checkApiRequest({ headers: { ...good, "x-cyphra-studio": undefined }, method: "GET" }, opts),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      checkApiRequest(
        { headers: { ...good, cookie: "cyphra_studio_5555=wrong" }, method: "GET" },
        opts,
      ),
    ).toMatchObject({ ok: false, status: 401 });
    expect(
      checkApiRequest({ headers: { ...good, cookie: undefined }, method: "GET" }, opts),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("redacts credentials from connection URIs", () => {
    expect(redactUri("neo4j+s://user:secret@db.example.io:7687?x=1")).toBe(
      "neo4j+s://db.example.io:7687",
    );
    expect(redactUri("bolt://127.0.0.1:7687")).toBe("bolt://127.0.0.1:7687");
    expect(redactUri(undefined)).toBe("");
  });
});
