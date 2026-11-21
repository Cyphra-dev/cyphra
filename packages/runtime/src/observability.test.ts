import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import neo4j from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CyphraClient, type DriverLike, type TransactionLike } from "./client.js";
import {
  cypherOperation,
  describeValue,
  findUnindexedFilters,
  redactParams,
  sanitizeCypher,
  type CyphraEvent,
  type TracerLike,
} from "./observability.js";
import { createClient } from "./orm/__fixtures__/blog.gen.js";

type Row = Record<string, unknown>;

/** In-memory driver: every statement returns `rows(text)`, or throws when `fail(text)` does. */
function fakeDriver(opts: { rows?: (text: string) => Row[]; fail?: (text: string) => unknown }) {
  const calls: { text: string; params: Row }[] = [];
  const run = async (text: string, params: Row = {}) => {
    calls.push({ text, params });
    const err = opts.fail?.(text);
    if (err) throw err;
    const rows = opts.rows?.(text) ?? [];
    return {
      records: rows.map((r) => ({ toObject: () => r, get: (k: string) => r[k] })),
      summary: { server: { address: "db.example.com:7688" }, database: { name: "neo4j" } },
    };
  };
  const tx: TransactionLike = { run };
  const driver: DriverLike = {
    session: () => ({
      run,
      executeRead: async (work) => work(tx),
      executeWrite: async (work) => work(tx),
      close: async () => {},
    }),
    close: async () => {},
  };
  return { driver, calls };
}

describe("parameter redaction", () => {
  it("replaces values by type placeholders", () => {
    expect(
      redactParams({
        s: "alice@example.com",
        n: 42,
        b: true,
        nil: null,
        list: ["a", "b", "c"],
        d: new Date(),
        i: neo4j.int(7),
        vec: new Float32Array(3),
        props: { email: "alice@example.com", age: 30, nested: { deep: { x: 1 } } },
      }),
    ).toEqual({
      s: "<string>",
      n: "<number>",
      b: "<boolean>",
      nil: "<null>",
      list: "<list(3)>",
      d: "<Date>",
      i: "<Integer>",
      vec: "<Float32Array(3)>",
      props: { email: "<string>", age: "<number>", nested: "<map>" },
    });
  });

  it("includes values with logParams, but never secret-looking keys", () => {
    expect(
      redactParams(
        { email: "a@x.io", password: "hunter2", props: { apiKey: "k", accessToken: "t", n: 1 } },
        true,
      ),
    ).toEqual({
      email: "a@x.io",
      password: "<redacted>",
      props: { apiKey: "<redacted>", accessToken: "<redacted>", n: 1 },
    });
    expect(redactParams({ token: "t" })).toEqual({ token: "<redacted>" });
  });

  it("describes unknown objects by constructor name", () => {
    expect(describeValue(new neo4j.types.Point(4326, 1, 2))).toBe("<Point>");
    expect(describeValue(10n)).toBe("<bigint>");
  });

  it("masks string literals in query text and finds the first clause", () => {
    expect(sanitizeCypher(`MATCH (n) WHERE n.a = 'x\\'y' AND n.b = "z" RETURN n`)).toBe(
      "MATCH (n) WHERE n.a = ? AND n.b = ? RETURN n",
    );
    expect(cypherOperation("  optional match (n) RETURN n")).toBe("OPTIONAL MATCH");
    expect(cypherOperation("UNWIND $rows AS r CREATE (n)")).toBe("UNWIND");
  });
});

describe("query events", () => {
  it("emits query events with model, operation, rows, duration and redacted params", async () => {
    const { driver } = fakeDriver({ rows: () => [{ row: { title: "Hello", published: true } }] });
    const events: CyphraEvent[] = [];
    const db = createClient({ driver, database: "blog", log: (e) => events.push(e) });
    await db.post.findMany({ where: { title: "Hello" } });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({
      type: "query",
      model: "Post",
      operation: "findMany",
      rows: 1,
      database: "blog",
      transaction: false,
      params: { p0: "<string>" },
    });
    if (e.type !== "query") throw new Error("expected a query event");
    expect(e.text).toMatch(/^MATCH \(n:`?Post`?\) WHERE/);
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
    expect(e.timestamp).toBeInstanceOf(Date);
    expect(JSON.stringify(events)).not.toContain("Hello");
  });

  it("marks statements inside $transaction and reports $cypher", async () => {
    const { driver } = fakeDriver({ rows: () => [{ n: 1 }] });
    const db = createClient({ driver });
    const events: CyphraEvent[] = [];
    const off = db.$on("query", (e) => events.push(e));
    await db.$transaction(async (tx) => {
      await tx.user.count();
      await tx.$cypher`RETURN ${1} AS n`;
    });
    await db.$cypher`RETURN 1 AS n`;
    off();
    await db.$cypher`RETURN 2 AS n`;
    expect(
      events.map((e) => [e.type === "query" && e.operation, "transaction" in e && e.transaction]),
    ).toEqual([
      ["count", true],
      ["$cypher", true],
      ["$cypher", false],
    ]);
    expect(events[0]).toMatchObject({ model: "User", database: "neo4j" });
  });

  it("emits error events with the Neo4j code and rethrows", async () => {
    const err = Object.assign(new Error("Invalid input"), {
      code: "Neo.ClientError.Statement.SyntaxError",
      gqlStatus: "42001",
    });
    const { driver } = fakeDriver({ fail: () => err });
    const db = createClient({ driver });
    const errors: CyphraEvent[] = [];
    db.$on("error", (e) => errors.push(e));
    await expect(db.$cypher`RETURN ${"secret value"} AS x`).rejects.toBe(err);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "error",
      operation: "$cypher",
      code: "Neo.ClientError.Statement.SyntaxError",
      gqlStatus: "42001",
      message: "Invalid input",
      params: { p0: "<string>" },
      error: err,
    });
  });

  it("prints levels listed in `log` and never the credentials", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { driver } = fakeDriver({
        fail: (t) => (t.includes("boom") ? new Error("boom") : undefined),
      });
      const client = new CyphraClient({ driver, log: ["query", "error"] });
      await client.withSession((s) => client.runCompiled(s, { text: "RETURN 1", params: {} }));
      await expect(
        client.withSession((s) => client.runCompiled(s, { text: "RETURN boom", params: {} })),
      ).rejects.toThrow("boom");
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]![0])).toMatch(/^\[cyphra:query\] \d+\.\dms 0 rows RETURN 1/);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]![0])).toContain("[cyphra:error]");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("keeps the deprecated debug option (redacted params)", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const { driver } = fakeDriver({});
      const db = createClient({ driver, debug: true });
      await db.user.findMany({ where: { email: "a@x.io" } });
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls[0]![1]).toEqual({ p0: "<string>" });
    } finally {
      debug.mockRestore();
    }
  });

  it("does nothing extra when no consumer is configured", async () => {
    const { driver, calls } = fakeDriver({});
    const db = createClient({ driver });
    await db.user.findMany();
    expect(calls).toHaveLength(1);
  });

  it("a throwing listener does not fail the query", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { driver } = fakeDriver({});
      const db = createClient({ driver });
      db.$on("query", () => {
        throw new Error("listener bug");
      });
      await expect(db.user.findMany()).resolves.toEqual([]);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe("OpenTelemetry spans", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer: TracerLike = provider.getTracer("cyphra-test");

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });
  afterAll(() => {
    context.disable();
  });
  beforeEach(() => exporter.reset());

  it("creates an operation span with a child statement span", async () => {
    const { driver } = fakeDriver({ rows: () => [{ row: { title: "x" } }] });
    const db = createClient({ driver, tracer, traceQueryText: true });
    await db.post.findMany({ where: { title: "x" } });
    const spans = exporter.getFinishedSpans();
    const op = spans.find((s) => s.name === "cyphra.Post.findMany")!;
    const stmt = spans.find((s) => s.name === "MATCH Post")!;
    expect(op).toBeDefined();
    expect(stmt).toBeDefined();
    expect(stmt.parentSpanContext?.spanId).toBe(op.spanContext().spanId);
    expect(op.attributes).toMatchObject({
      "db.system.name": "neo4j",
      "db.operation.name": "findMany",
      "cyphra.model": "Post",
    });
    expect(stmt.attributes).toMatchObject({
      "db.system.name": "neo4j",
      "db.operation.name": "MATCH",
      "db.namespace": "neo4j",
      "db.response.returned_rows": 1,
      "server.address": "db.example.com",
      "server.port": 7688,
    });
    expect(String(stmt.attributes["db.query.text"])).toMatch(/^MATCH/);
    expect(stmt.kind).toBe(2); // CLIENT
  });

  it("omits db.query.text unless traceQueryText is set", async () => {
    const { driver } = fakeDriver({});
    const db = createClient({ driver, tracer });
    await db.user.count();
    const stmt = exporter.getFinishedSpans().find((s) => s.name === "MATCH User")!;
    expect(stmt.attributes["db.query.text"]).toBeUndefined();
  });

  it("propagates context through $transaction and the caller's span", async () => {
    const { driver } = fakeDriver({});
    const db = createClient({ driver, tracer });
    await tracer.startActiveSpan("request", {}, async (root) => {
      await db.$transaction(async (tx) => {
        await tx.user.findMany();
        await tx.post.count();
      });
      root.end();
    });
    const spans = exporter.getFinishedSpans();
    const byName = (n: string) => spans.find((s) => s.name === n)!;
    const root = byName("request");
    const txSpan = byName("cyphra.$transaction");
    expect(txSpan.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(byName("cyphra.User.findMany").parentSpanContext?.spanId).toBe(
      txSpan.spanContext().spanId,
    );
    expect(byName("cyphra.Post.count").parentSpanContext?.spanId).toBe(txSpan.spanContext().spanId);
    expect(byName("MATCH Post").parentSpanContext?.spanId).toBe(
      byName("cyphra.Post.count").spanContext().spanId,
    );
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
  });

  it("records errors on both spans", async () => {
    const err = Object.assign(new Error("Constraint"), {
      code: "Neo.ClientError.Schema.ConstraintValidationFailed",
    });
    const { driver } = fakeDriver({ fail: () => err });
    const db = createClient({ driver, tracer });
    await expect(db.user.findMany()).rejects.toBe(err);
    const spans = exporter.getFinishedSpans();
    for (const s of spans) {
      expect(s.status.code).toBe(2);
      expect(s.attributes["error.type"]).toBe("Neo.ClientError.Schema.ConstraintValidationFailed");
      expect(s.events.some((e) => e.name === "exception")).toBe(true);
    }
    expect(spans).toHaveLength(2);
  });

  it("accepts the @opentelemetry/api Tracer type", () => {
    const t: TracerLike = trace.getTracer("x");
    expect(t).toBeDefined();
  });
});

describe("findUnindexedFilters", () => {
  const plan = (operatorType: string, Details: string, ...children: object[]) => ({
    operatorType,
    arguments: { Details },
    children,
  });

  it("finds properties filtered on top of a label scan", () => {
    const p = plan(
      "ProduceResults@neo4j",
      "row",
      plan(
        "Projection@neo4j",
        "n{.title} AS row",
        plan(
          "Filter@neo4j",
          "n.title = $p0 AND n.`views` > $p1",
          plan("NodeByLabelScan@neo4j", "n:Post"),
        ),
      ),
    );
    expect(findUnindexedFilters(p)).toEqual([
      { label: "Post", property: "title" },
      { label: "Post", property: "views" },
    ]);
  });

  it("handles AllNodesScan with the label in the filter, and ignores expanded nodes", () => {
    const p = plan(
      "Filter@neo4j",
      "n:User AND n.email = $p0 AND m.name = $p1",
      plan("Expand(All)@neo4j", "(n)-[r]->(m)", plan("AllNodesScan@neo4j", "n")),
    );
    expect(findUnindexedFilters(p)).toEqual([{ label: "User", property: "email" }]);
  });

  it("ignores index seeks and missing plans", () => {
    expect(
      findUnindexedFilters(
        plan("Filter", "n.title = $p0", plan("NodeIndexSeek@neo4j", "RANGE INDEX n:Post(title)")),
      ),
    ).toEqual([]);
    expect(findUnindexedFilters(false)).toEqual([]);
  });
});
