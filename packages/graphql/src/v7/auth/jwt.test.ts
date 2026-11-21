import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JwtDecoder, parseBearerToken } from "./jwt.js";

// Keys are generated for each run; nothing here is a real secret.
const secret = `test-secret-${Math.random().toString(36).slice(2)}`;
const enc = (s: string) => new TextEncoder().encode(s);

async function hs256(payload: Record<string, unknown>, key = secret): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).sign(enc(key));
}

describe("parseBearerToken", () => {
  it("accepts `Bearer <jwt>` and a bare token", () => {
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("abc")).toBe("abc");
    expect(parseBearerToken("Bearer ")).toBeUndefined();
  });
});

describe("JwtDecoder with a secret", () => {
  const decoder = new JwtDecoder({ key: secret });

  it("verifies a valid token", async () => {
    const token = await hs256({ sub: "u1", roles: ["admin"] });
    expect(await decoder.decode({ token: `Bearer ${token}` })).toMatchObject({ sub: "u1" });
  });

  it("rejects expired, not-yet-valid, forged, unsigned and malformed tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      await hs256({ sub: "u1", exp: now - 60 }),
      await hs256({ sub: "u1", nbf: now + 3600 }),
      await hs256({ sub: "u1" }, "another-key"),
      new UnsecuredJWT({ sub: "u1" }).encode(),
      "not.a.jwt",
      "",
    ];
    for (const token of cases) {
      expect(await decoder.decode({ token: `Bearer ${token}` })).toBeUndefined();
    }
    expect(await decoder.decode({})).toBeUndefined();
    expect(await decoder.decode({ token: 42 })).toBeUndefined();
  });

  it("applies verifyOptions (issuer, audience)", async () => {
    const strict = new JwtDecoder({
      key: secret,
      verifyOptions: { issuer: "me", audience: "api" },
    });
    const ok = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("me")
      .setAudience("api")
      .sign(enc(secret));
    expect(await strict.decode({ token: ok })).toMatchObject({ sub: "u1" });
    expect(
      await strict.decode({ token: await hs256({ sub: "u1", iss: "other" }) }),
    ).toBeUndefined();
  });

  it("resolves the key per request when it is a function", async () => {
    const perTenant = new JwtDecoder({ key: (ctx) => `${secret}-${String(ctx.tenant)}` });
    const token = await hs256({ sub: "u1" }, `${secret}-a`);
    expect(await perTenant.decode({ token, tenant: "a" })).toMatchObject({ sub: "u1" });
    expect(await perTenant.decode({ token, tenant: "b" })).toBeUndefined();
  });

  it("with verify: false decodes without checking the signature (v7 option)", async () => {
    const unverified = new JwtDecoder({ key: secret, verify: false });
    const forged = await hs256({ sub: "u1" }, "another-key");
    expect(await unverified.decode({ token: forged })).toMatchObject({ sub: "u1" });
  });
});

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

describe("JwtDecoder with a JWKS endpoint", () => {
  let server: Server;
  let url: string;
  let privateKey: PrivateKey;
  let otherKey: PrivateKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair("RS256")).privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const rs256 = (key: PrivateKey, payload: Record<string, unknown>) =>
    new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "k1" }).sign(key);

  it("verifies tokens signed by a key of the set, rejects the others", async () => {
    const decoder = new JwtDecoder({ key: { url } });
    expect(await decoder.decode({ token: await rs256(privateKey, { sub: "u1" }) })).toMatchObject({
      sub: "u1",
    });
    expect(await decoder.decode({ token: await rs256(otherKey, { sub: "u1" }) })).toBeUndefined();
    // Algorithm confusion: an HS256 token cannot be verified against the JWKS.
    expect(await decoder.decode({ token: await hs256({ sub: "u1" }) })).toBeUndefined();
  });
});
