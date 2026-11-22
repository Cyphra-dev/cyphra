import { Controller, Get, Inject, Injectable, Module } from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants.js";
import { HealthCheckService, TerminusModule } from "@nestjs/terminus";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import {
  CyphraHealthCheckError,
  CyphraHealthIndicator,
  CyphraModule,
  InjectCyphra,
  Transactional,
  getCyphraToken,
  getTransaction,
  isInTransaction,
} from "../src/index.js";
import { fakeClient, type FakeClient } from "./fake-client.js";

@Injectable()
class AuditService {
  constructor(@InjectCyphra() readonly db: FakeClient) {}

  record(): Promise<string> {
    return this.db.user.findMany();
  }

  @Transactional()
  async recordInOwnTransaction(): Promise<string> {
    return this.db.user.findMany();
  }
}

@Injectable()
class AccountsService {
  constructor(
    @InjectCyphra() readonly db: FakeClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  plain(): Promise<string> {
    return this.db.user.findMany();
  }

  @Transactional()
  async both(): Promise<string[]> {
    return [await this.db.user.findMany(), await this.audit.record()];
  }

  @Transactional()
  async nested(): Promise<string[]> {
    return [await this.db.user.findMany(), await this.audit.recordInOwnTransaction()];
  }

  @Transactional()
  async fails(): Promise<void> {
    await this.db.user.findMany();
    throw new Error("boom");
  }

  @Transactional()
  async current(): Promise<unknown> {
    return { tx: getTransaction(), inTx: isInTransaction() };
  }
}

async function app(client: FakeClient, options: { closeOnShutdown?: boolean } = {}) {
  const moduleRef = await Test.createTestingModule({
    imports: [CyphraModule.forRoot({ client, ...options })],
    providers: [AuditService, AccountsService],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe("CyphraModule", () => {
  it("injects the client (outside a transaction, calls reach it unchanged)", async () => {
    const client = fakeClient();
    const ref = await app(client);
    const accounts = ref.get(AccountsService);
    expect(await accounts.plain()).toBe("root");
    expect(accounts.db.label).toBe("root");
    expect(ref.get(getCyphraToken())).toBe(accounts.db);
    expect(isInTransaction()).toBe(false);
    await ref.close();
  });

  it("forRoot accepts a factory, forRootAsync injects its dependencies", async () => {
    const client = fakeClient();
    const viaFactory = await Test.createTestingModule({
      imports: [CyphraModule.forRoot({ client: () => client })],
    }).compile();
    expect(viaFactory.get<FakeClient>(getCyphraToken()).label).toBe("root");
    await viaFactory.close();

    const CONFIG = Symbol("config");
    @Module({ providers: [{ provide: CONFIG, useValue: { uri: "bolt://x" } }], exports: [CONFIG] })
    class ConfigModule {}
    let seen: unknown;
    const viaAsync = await Test.createTestingModule({
      imports: [
        CyphraModule.forRootAsync({
          imports: [ConfigModule],
          inject: [CONFIG],
          useFactory: async (config: { uri: string }) => {
            seen = config.uri;
            return client;
          },
        }),
      ],
    }).compile();
    expect(seen).toBe("bolt://x");
    expect(viaAsync.get<FakeClient>(getCyphraToken()).label).toBe("root");
    await viaAsync.close();
  });

  it("closes the client when the application closes (unless closeOnShutdown is false)", async () => {
    const client = fakeClient();
    const ref = await app(client);
    expect(client.disconnected).toBe(0);
    await ref.close();
    expect(client.disconnected).toBe(1);

    const kept = fakeClient();
    await (await app(kept, { closeOnShutdown: false })).close();
    expect(kept.disconnected).toBe(0);
  });

  it("registers named connections side by side", async () => {
    const main = fakeClient();
    const other = fakeClient();
    other.label = "other";

    @Injectable()
    class TwoDbs {
      constructor(
        @InjectCyphra() readonly main: FakeClient,
        @InjectCyphra("analytics") readonly analytics: FakeClient,
      ) {}

      @Transactional({ connection: "analytics" })
      async onAnalytics() {
        return [await this.main.user.findMany(), await this.analytics.user.findMany()];
      }
    }

    const ref = await Test.createTestingModule({
      imports: [
        CyphraModule.forRoot({ client: main }),
        CyphraModule.forRoot({ client: other, connection: "analytics" }),
      ],
      providers: [TwoDbs],
    }).compile();
    await ref.init();
    const svc = ref.get(TwoDbs);
    expect(svc.main.label).toBe("root");
    expect(svc.analytics.label).toBe("other");
    // Only the analytics client is in a transaction.
    expect(await svc.onAnalytics()).toEqual(["root", "tx1"]);
    expect(main.transactions.committed).toBe(0);
    expect(other.transactions.committed).toBe(1);
    await ref.close();
    expect([main.disconnected, other.disconnected]).toEqual([1, 1]);
  });
});

describe("@Transactional()", () => {
  it("runs the method and the services it calls in one transaction", async () => {
    const client = fakeClient();
    const ref = await app(client);
    expect(await ref.get(AccountsService).both()).toEqual(["tx1", "tx1"]);
    expect(client.transactions).toEqual({ committed: 1, rolledBack: 0 });
    await ref.close();
  });

  it("joins the outer transaction from a nested @Transactional() method", async () => {
    const client = fakeClient();
    const ref = await app(client);
    expect(await ref.get(AccountsService).nested()).toEqual(["tx1", "tx1"]);
    expect(client.transactions.committed).toBe(1);
    await ref.close();
  });

  it("rolls back when the method throws", async () => {
    const client = fakeClient();
    const ref = await app(client);
    await expect(ref.get(AccountsService).fails()).rejects.toThrow("boom");
    expect(client.transactions).toEqual({ committed: 0, rolledBack: 1 });
    await ref.close();
  });

  it("keeps concurrent transactions apart", async () => {
    const client = fakeClient();
    const ref = await app(client);
    const accounts = ref.get(AccountsService);
    const [a, b] = await Promise.all([accounts.both(), accounts.both()]);
    expect(new Set(a).size).toBe(1);
    expect(new Set(b).size).toBe(1);
    expect(a[0]).not.toBe(b[0]);
    await ref.close();
  });

  it("exposes the transaction client with getTransaction()", async () => {
    const client = fakeClient();
    const ref = await app(client);
    const { tx, inTx } = (await ref.get(AccountsService).current()) as {
      tx: FakeClient;
      inTx: boolean;
    };
    expect(inTx).toBe(true);
    expect(await tx.user.findMany()).toBe("tx1");
    expect(getTransaction()).toBeUndefined();
    await ref.close();
  });

  it("makes $transaction callbacks visible to the services they call, and joins inside one", async () => {
    const client = fakeClient();
    const ref = await app(client);
    const accounts = ref.get(AccountsService);
    const out = await accounts.db.$transaction(async (tx) => [
      await (tx as FakeClient).user.findMany(),
      await accounts.plain(),
      // Inside a transaction, $transaction runs its callback on the same one.
      await accounts.db.$transaction(async (inner) => (inner as FakeClient).user.findMany()),
      await accounts.both(),
    ]);
    expect(out).toEqual(["tx1", "tx1", "tx1", ["tx1", "tx1"]]);
    expect(client.transactions.committed).toBe(1);
    await ref.close();
  });

  it("fails clearly when no client is registered for the connection", async () => {
    class Lonely {
      @Transactional("nowhere")
      async run() {
        return 1;
      }
    }
    await expect(new Lonely().run()).rejects.toThrow(/no Cyphra client for connection "nowhere"/);
  });

  it("rejects non-methods and keeps the metadata of other decorators", () => {
    expect(() =>
      Transactional()({}, "x", { value: 1 } as unknown as TypedPropertyDescriptor<unknown>),
    ).toThrow(TypeError);

    @Controller("accounts")
    class AccountsController {
      @Transactional()
      @Get("list")
      async list() {
        return [];
      }
    }
    const method = AccountsController.prototype.list;
    expect(method.name).toBe("list");
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBe("list");
  });
});

/** The indicator's result: returned (Terminus 11+), or thrown as `causes` (Terminus 10). */
const outcome = (p: Promise<unknown>) =>
  p.catch((e: unknown) => {
    if (e instanceof CyphraHealthCheckError) return e.causes;
    throw e;
  });

describe("CyphraHealthIndicator", () => {
  it("reports up and down", async () => {
    const client = fakeClient();
    const ref = await app(client);
    const indicator = ref.get(CyphraHealthIndicator);
    expect(await indicator.isHealthy("neo4j")).toEqual({ neo4j: { status: "up" } });
    expect(await indicator.isHealthy()).toEqual({ cyphra: { status: "up" } });

    client.failPing = new Error("connection refused");
    expect(await outcome(indicator.isHealthy("neo4j"))).toEqual({
      neo4j: { status: "down", message: "connection refused" },
    });
    await ref.close();
  });

  it("times out", async () => {
    const client = fakeClient();
    client.$cypher = () => new Promise(() => {});
    const ref = await app(client);
    await expect(
      outcome(ref.get(CyphraHealthIndicator).isHealthy("neo4j", { timeout: 20 })),
    ).resolves.toEqual({ neo4j: { status: "down", message: "timeout of 20ms exceeded" } });
    await ref.close();
  });

  it("plugs into @nestjs/terminus HealthCheckService", async () => {
    const client = fakeClient();
    const ref = await Test.createTestingModule({
      imports: [TerminusModule.forRoot({ logger: false }), CyphraModule.forRoot({ client })],
    }).compile();
    await ref.init();
    const health = ref.get(HealthCheckService);
    const indicator = ref.get(CyphraHealthIndicator);
    expect(await health.check([() => indicator.isHealthy("neo4j")])).toMatchObject({
      status: "ok",
      info: { neo4j: { status: "up" } },
    });

    client.failPing = new Error("unreachable");
    const failure = await health
      .check([() => indicator.isHealthy("neo4j")])
      .catch((e: { getStatus(): number; getResponse(): unknown }) => e);
    expect((failure as { getStatus(): number }).getStatus()).toBe(503);
    expect((failure as { getResponse(): unknown }).getResponse()).toMatchObject({
      status: "error",
      error: { neo4j: { status: "down", message: "unreachable" } },
    });
    await ref.close();
  });
});
