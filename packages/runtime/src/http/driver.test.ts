import { cypher } from "@cyphra/query";
import { describe, expect, it } from "vitest";
import { CyphraClient, httpBaseUrl } from "../client.js";
import { CypherInteger } from "../cypher-values.js";
import type { CyphraEvent, ErrorEvent, QueryEvent } from "../observability.js";
import { createClient } from "../orm/__fixtures__/blog.gen.js";
import { HttpDriver, Neo4jHttpError, TYPED_JSON, basicAuth, type FetchLike } from "./driver.js";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };

/** A `fetch` that records requests and answers from `reply`. */
function mockFetch(reply: (call: Call, index: number) => Reply | Error) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = {
      method: String(init.method),
      url,
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = reply(call, calls.length - 1);
    if (r instanceof Error) throw r;
    return new Response(r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body)), {
      status: r.status ?? 202,
      headers: { "Content-Type": TYPED_JSON, ...r.headers },
    });
  };
  return { fetch, calls };
}

const int = (v: number) => ({ $type: "Integer", _value: String(v) });
const rows = (fields: string[], values: unknown[][], extra: object = {}) => ({
  data: { fields, values },
  bookmarks: ["bm1"],
  ...extra,
});

describe("HttpDriver auto-commit", () => {
  it("posts typed JSON to /db/{db}/query/v2 and decodes the rows", async () => {
    const { fetch, calls } = mockFetch(() => ({
      body: rows(["n", "s"], [[int(42), { $type: "String", _value: "x" }]]),
    }));
    const driver = new HttpDriver({
      url: "https://db.example.io/",
      authorization: basicAuth("neo4j", "secret"),
      database: "movies",
      fetch,
      headers: { "X-App": "test" },
    });
    const res = await driver.session().run("RETURN $a AS n, $b AS s", { a: 1n, b: 1.5 });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c!.method).toBe("POST");
    expect(c!.url).toBe("https://db.example.io/db/movies/query/v2");
    expect(c!.headers).toMatchObject({
      Accept: TYPED_JSON,
      "Content-Type": TYPED_JSON,
      Authorization: `Basic ${btoa("neo4j:secret")}`,
      "X-App": "test",
    });
    expect(c!.body).toEqual({
      statement: "RETURN $a AS n, $b AS s",
      parameters: { a: int(1), b: { $type: "Float", _value: "1.5" } },
    });
    expect(res.keys).toEqual(["n", "s"]);
    expect(res.records[0]!.get("n")).toEqual(new CypherInteger(42));
    expect(res.records[0]!.get(1)).toBe("x");
    expect(res.records[0]!.toObject()).toEqual({ n: new CypherInteger(42), s: "x" });
    expect(res.summary.database.name).toBe("movies");
    expect(res.summary.server.address).toBe("db.example.io");
    expect(() => res.records[0]!.get("nope")).toThrow(/no field "nope"/);
  });

  it("sends the session's bookmarks with later statements", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: rows([], []) }));
    const session = new HttpDriver({ url: "http://localhost:7474", fetch }).session();
    await session.run("CREATE ()");
    await session.run("MATCH (n) RETURN n");
    expect(calls[0]!.url).toBe("http://localhost:7474/db/neo4j/query/v2");
    expect((calls[0]!.body as { bookmarks?: unknown }).bookmarks).toBeUndefined();
    expect((calls[1]!.body as { bookmarks?: unknown }).bookmarks).toEqual(["bm1"]);
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("maps Neo4j errors, HTTP errors and network failures to Neo4jHttpError", async () => {
    const replies: (Reply | Error)[] = [
      {
        status: 400,
        body: {
          errors: [{ code: "Neo.ClientError.Statement.SyntaxError", message: "Invalid input" }],
        },
      },
      // Errors in a 202 response (failure while streaming).
      {
        body: {
          data: { fields: ["x"], values: [] },
          errors: [{ code: "Neo.ClientError.Statement.ArithmeticError", message: "/ by zero" }],
        },
      },
      {
        status: 401,
        body: {
          errors: [
            { code: "Neo.ClientError.Security.Unauthorized", message: "Invalid credential." },
          ],
        },
      },
      { status: 502, text: "<html>Bad gateway</html>" },
      new TypeError("fetch failed"),
    ];
    const { fetch } = mockFetch((_, i) => replies[i]!);
    const session = new HttpDriver({ url: "http://localhost:7474", fetch }).session();
    const errors: Neo4jHttpError[] = [];
    for (let i = 0; i < replies.length; i++) {
      errors.push(
        await session.run("RETURN 1").then(
          () => {
            throw new Error("no error");
          },
          (e: Neo4jHttpError) => e,
        ),
      );
    }
    expect(errors.every((e) => e instanceof Neo4jHttpError)).toBe(true);
    expect(errors.map((e) => [e.code, e.status])).toEqual([
      ["Neo.ClientError.Statement.SyntaxError", 400],
      ["Neo.ClientError.Statement.ArithmeticError", 202],
      ["Neo.ClientError.Security.Unauthorized", 401],
      ["ServiceUnavailable", 502],
      ["ServiceUnavailable", 0],
    ]);
    expect(errors[0]!.message).toBe("Invalid input");
    expect(errors[0]!.name).toBe("Neo4jHttpError");
    expect(errors.map((e) => e.retriable)).toEqual([false, false, false, true, true]);
  });

  it("decodes EXPLAIN plans into summary.plan", async () => {
    const plan = {
      operatorType: "ProduceResults@neo4j",
      arguments: {
        Details: { $type: "String", _value: "n" },
        Id: { $type: "Integer", _value: "0" },
      },
      identifiers: ["n"],
      children: [
        {
          operatorType: "Filter@neo4j",
          arguments: { Details: "n.s = $x" },
          identifiers: ["n"],
          children: [],
        },
      ],
    };
    const { fetch } = mockFetch(() => ({ body: rows(["n"], [], { queryPlan: plan }) }));
    const res = await new HttpDriver({ url: "http://h:7474", fetch })
      .session()
      .run("EXPLAIN MATCH (n) RETURN n");
    expect(res.summary.plan).toEqual({
      operatorType: "ProduceResults@neo4j",
      arguments: { Details: "n", Id: 0 },
      identifiers: ["n"],
      children: [
        {
          operatorType: "Filter@neo4j",
          arguments: { Details: "n.s = $x" },
          identifiers: ["n"],
          children: [],
        },
      ],
    });
  });
});

describe("HttpDriver transactions", () => {
  const tx = (id: string) => ({ transaction: { id, expires: "2030-01-01T00:00:00Z" } });

  it("opens with the first statement, echoes the affinity header and commits", async () => {
    const { fetch, calls } = mockFetch((c) => {
      if (c.url.endsWith("/tx")) {
        return {
          body: rows(["a"], [[int(1)]], tx("t1")),
          headers: { "neo4j-cluster-affinity": "srv-7" },
        };
      }
      if (c.url.endsWith("/commit")) return { body: { bookmarks: ["bm-commit"] } };
      return { body: rows(["b"], [[int(2)]], tx("t1")) };
    });
    const session = new HttpDriver({ url: "https://h", fetch, database: "db1" }).session();
    const out = await session.executeWrite(async (t) => {
      const a = await t.run("RETURN 1 AS a");
      const b = await t.run("RETURN $x AS b", { x: 2n });
      return [a.records[0]!.get("a"), b.records[0]!.get("b")].map(String);
    });
    expect(out).toEqual(["1", "2"]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://h/db/db1/query/v2/tx",
      "POST https://h/db/db1/query/v2/tx/t1",
      "POST https://h/db/db1/query/v2/tx/t1/commit",
    ]);
    expect(calls[0]!.body).toEqual({
      statement: "RETURN 1 AS a",
      parameters: {},
      accessMode: "WRITE",
    });
    expect(calls[0]!.headers["neo4j-cluster-affinity"]).toBeUndefined();
    expect(calls[1]!.headers["neo4j-cluster-affinity"]).toBe("srv-7");
    expect(calls[2]!.headers["neo4j-cluster-affinity"]).toBe("srv-7");
    // Bookmarks of the commit are sent with the session's next transaction.
    await session.executeRead((t) => t.run("RETURN 1"));
    expect(calls[3]!.body).toMatchObject({ accessMode: "READ", bookmarks: ["bm-commit"] });
  });

  it("rolls back (DELETE) when the work throws, and serializes concurrent statements", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { fetch, calls } = mockFetch((c) => {
      if (c.method === "DELETE") return { body: {} };
      return { body: rows([], [], tx("t2")) };
    });
    const slowFetch: FetchLike = async (url, init) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return fetch(url, init);
    };
    const session = new HttpDriver({ url: "https://h", fetch: slowFetch }).session();
    await expect(
      session.executeWrite(async (t) => {
        await Promise.all([t.run("CREATE (:A)"), t.run("CREATE (:B)")]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(maxInFlight).toBe(1);
    expect(
      calls.map((c) => `${c.method} ${c.url.replace("https://h/db/neo4j/query/v2", "")}`),
    ).toEqual(["POST /tx", "POST /tx/t2", "DELETE /tx/t2"]);
  });

  it("does not roll back a transaction the server already closed after an error", async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url.endsWith("/tx")
        ? { body: rows([], [], tx("t3")) }
        : {
            body: {
              errors: [
                {
                  code: "Neo.ClientError.Schema.ConstraintValidationFailed",
                  message: "already exists",
                },
              ],
            },
          },
    );
    const session = new HttpDriver({ url: "https://h", fetch }).session();
    const err = await session
      .executeWrite(async (t) => {
        await t.run("CREATE (:A)");
        await t.run("CREATE (:A)");
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Neo4jHttpError);
    expect((err as Neo4jHttpError).code).toBe("Neo.ClientError.Schema.ConstraintValidationFailed");
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
  });

  it("sends no request for a transaction that runs nothing", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: {} }));
    const v = await new HttpDriver({ url: "https://h", fetch }).session().executeWrite(() => 7);
    expect(v).toBe(7);
    expect(calls).toHaveLength(0);
  });

  it("retries the whole work on transient errors", async () => {
    let attempt = 0;
    const { fetch, calls } = mockFetch((c) => {
      if (c.url.endsWith("/commit")) {
        attempt++;
        return attempt === 1
          ? {
              body: {
                errors: [
                  { code: "Neo.TransientError.Transaction.DeadlockDetected", message: "deadlock" },
                ],
              },
            }
          : { body: { bookmarks: [] } };
      }
      return { body: rows([], [], tx(`t${attempt}`)) };
    });
    let runs = 0;
    await new HttpDriver({ url: "https://h", fetch, maxRetryTimeMs: 5_000 })
      .session()
      .executeWrite(async (t) => {
        runs++;
        await t.run("CREATE ()");
      });
    expect(runs).toBe(2);
    expect(calls.filter((c) => c.url.endsWith("/commit"))).toHaveLength(2);
  });

  it("gives up retrying after maxRetryTimeMs", async () => {
    const { fetch } = mockFetch(() => new TypeError("network down"));
    const err = await new HttpDriver({ url: "https://h", fetch, maxRetryTimeMs: 0 })
      .session()
      .executeRead((t) => t.run("RETURN 1"))
      .catch((e: unknown) => e);
    expect((err as Neo4jHttpError).code).toBe("ServiceUnavailable");
  });
});

describe("HttpDriver concurrency limit", () => {
  it("keeps at most maxConcurrency transactions and statements in flight", async () => {
    let inFlight = 0;
    let max = 0;
    const fetch: FetchLike = async (url) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const body = url.endsWith("/commit")
        ? {}
        : { data: { fields: [], values: [] }, transaction: { id: "t" } };
      return new Response(JSON.stringify(body), { status: 202 });
    };
    const driver = new HttpDriver({ url: "https://h", fetch, maxConcurrency: 2 });
    let txInFlight = 0;
    let maxTx = 0;
    await Promise.all([
      ...Array.from({ length: 6 }, () =>
        driver.session().executeWrite(async (tx) => {
          txInFlight++;
          maxTx = Math.max(maxTx, txInFlight);
          await tx.run("CREATE ()");
          await tx.run("CREATE ()");
          txInFlight--;
        }),
      ),
      ...Array.from({ length: 6 }, () => driver.session().run("RETURN 1")),
    ]);
    expect(max).toBe(2);
    expect(maxTx).toBeLessThanOrEqual(2);
  });

  it("fails after acquisitionTimeoutMs when no slot frees up", async () => {
    const fetch: FetchLike = () => new Promise(() => {}); // never answers
    const driver = new HttpDriver({
      url: "https://h",
      fetch,
      maxConcurrency: 1,
      acquisitionTimeoutMs: 20,
    });
    void driver.session().run("RETURN 1");
    await expect(driver.session().run("RETURN 2")).rejects.toMatchObject({
      code: "ConnectionAcquisitionTimeout",
    });
    expect(() => new HttpDriver({ url: "https://h", fetch, maxConcurrency: 0 })).toThrow(
      /positive integer/,
    );
  });
});

describe("CyphraClient over HTTP", () => {
  it("picks the HTTP transport for http(s) URIs or transport: 'http'", () => {
    const fetch: FetchLike = async () => new Response("{}");
    expect(new CyphraClient({ uri: "https://h", user: "u", password: "p", fetch }).transport).toBe(
      "http",
    );
    expect(
      new CyphraClient({ uri: "neo4j+s://h", transport: "http", token: "t", fetch }).transport,
    ).toBe("http");
    expect(
      new CyphraClient({ uri: "bolt://localhost:7687", user: "u", password: "p" }).transport,
    ).toBe("bolt");
    expect(httpBaseUrl("neo4j+s://abc.databases.neo4j.io")).toBe("https://abc.databases.neo4j.io");
    expect(httpBaseUrl("bolt+ssc://h:7687")).toBe("https://h");
    expect(httpBaseUrl("neo4j://h:7687")).toBe("http://h:7474");
    expect(httpBaseUrl("http://h:7474")).toBe("http://h:7474");
    expect(() => httpBaseUrl("ftp://h")).toThrow(/Unsupported URI scheme/);
  });

  it("sends a Bearer token", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: rows(["n"], [[int(1)]]) }));
    const client = new CyphraClient({ uri: "https://h", token: "tok", fetch });
    const rows_ = await client.withSession((s) => client.queryRecords(s, cypher`RETURN 1 AS n`));
    expect(rows_.map((r) => String(r.n))).toEqual(["1"]);
    expect(calls[0]!.headers.Authorization).toBe("Bearer tok");
  });

  it("runs the ORM: nested writes in one transaction, events and spans for every statement", async () => {
    const events: CyphraEvent[] = [];
    const spans: { name: string; attributes: Record<string, unknown> }[] = [];
    const tracer = {
      startSpan(name: string, opts?: { attributes?: Record<string, unknown> }) {
        const s = { name, attributes: { ...opts?.attributes } };
        spans.push(s);
        return {
          setAttribute: (k: string, v: unknown) => void (s.attributes[k] = v),
          recordException() {},
          setStatus() {},
          end() {},
        };
      },
      startActiveSpan<F extends (span: never) => unknown>(name: string, ...args: unknown[]) {
        const fn = args[args.length - 1] as (span: unknown) => unknown;
        return fn(this.startSpan(name)) as ReturnType<F>;
      },
    };
    const { fetch, calls } = mockFetch((c) => {
      if (c.url.endsWith("/commit")) return { body: { bookmarks: [] } };
      const statement = (c.body as { statement: string }).statement;
      if (statement.includes("RETURN 1/0")) {
        return {
          status: 202,
          body: {
            errors: [{ code: "Neo.ClientError.Statement.ArithmeticError", message: "/ by zero" }],
          },
        };
      }
      const t = { transaction: { id: "tx9" } };
      if (statement.startsWith("CREATE")) {
        return { body: rows(["id"], [[{ $type: "String", _value: "4:x:0" }]], t) };
      }
      // The read-back of create: one user row.
      const user = {
        id: { $type: "String", _value: "u1" },
        email: { $type: "String", _value: "a@x.io" },
        age: int(30),
        createdAt: { $type: "OffsetDateTime", _value: "2024-01-02T03:04:05Z" },
      };
      return { body: rows(["row"], [[{ $type: "Map", _value: user }]], t) };
    });
    const db = createClient({
      uri: "https://h",
      user: "neo4j",
      password: "pw",
      fetch,
      log: (e) => events.push(e),
      tracer: tracer as never,
    });
    expect(db.$client.transport).toBe("http");
    const u = await db.user.create({ data: { email: "a@x.io", age: 30 } });
    expect(u).toMatchObject({ email: "a@x.io", age: 30 });
    expect((u as { createdAt: Date }).createdAt.toISOString()).toBe("2024-01-02T03:04:05.000Z");

    // The ORM's Int is sent as a typed Integer, the DateTime default as an OffsetDateTime.
    const first = calls[0]!;
    expect(first.url).toBe("https://h/db/neo4j/query/v2/tx");
    const sent = JSON.stringify(first.body);
    expect(sent).toContain('{"$type":"Integer","_value":"30"}');
    expect(sent).toContain('"$type":"OffsetDateTime"');
    expect(calls.at(-1)!.url).toBe("https://h/db/neo4j/query/v2/tx/tx9/commit");

    const q = events.filter((e): e is QueryEvent => e.type === "query");
    expect(q.length).toBeGreaterThan(0);
    expect(q.map((e) => [e.model, e.operation, e.rows, e.transaction])).toEqual([
      ["User", "create", 1, false],
      ["User", "create", 1, false],
    ]);
    expect(calls.map((c) => c.url.replace("https://h/db/neo4j/query/v2", ""))).toEqual([
      "/tx",
      "/tx/tx9",
      "/tx/tx9/commit",
    ]);
    expect(
      spans.some(
        (s) => s.attributes["server.address"] === "h" && s.attributes["server.port"] === 443,
      ),
    ).toBe(true);

    await expect(db.$cypher`RETURN 1/0`).rejects.toMatchObject({
      code: "Neo.ClientError.Statement.ArithmeticError",
    });
    const err = events.find((e): e is ErrorEvent => e.type === "error");
    expect(err).toMatchObject({
      operation: "$cypher",
      code: "Neo.ClientError.Statement.ArithmeticError",
    });
    await db.$disconnect();
  });
});
