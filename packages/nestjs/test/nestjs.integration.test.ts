import { Inject, Injectable } from "@nestjs/common";
import { HealthCheckService, TerminusModule } from "@nestjs/terminus";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CyphraHealthIndicator,
  CyphraModule,
  InjectCyphra,
  Transactional,
  getCyphraToken,
} from "../src/index.js";
import { createClient, type Db } from "./fixtures/db.gen.js";

const { NEO4J_TEST_URI, NEO4J_TEST_USER, NEO4J_TEST_PASSWORD } = process.env;
const hasNeo = Boolean(NEO4J_TEST_URI && NEO4J_TEST_USER && NEO4J_TEST_PASSWORD);
// Transactions are not supported on FalkorDB; the suite targets Neo4j (and runs on Memgraph).
const skip = !hasNeo || process.env.CYPHRA_TEST_DIALECT === "falkordb";

const connect = () =>
  createClient({ uri: NEO4J_TEST_URI!, user: NEO4J_TEST_USER!, password: NEO4J_TEST_PASSWORD! });

@Injectable()
class LedgerService {
  constructor(@InjectCyphra() private readonly db: Db) {}

  /** Joins the caller's transaction: called on its own, each query commits by itself. */
  async record(from: string, amount: number) {
    return this.db.nxTransfer.create({
      data: { amount, from: { connect: { owner: from } } },
    });
  }
}

@Injectable()
class BankService {
  constructor(
    @InjectCyphra() readonly db: Db,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  @Transactional()
  async transfer(from: string, to: string, amount: number) {
    await this.db.nxAccount.update({
      where: { owner: from },
      data: { balance: { decrement: amount } },
    });
    await this.db.nxAccount.update({
      where: { owner: to },
      data: { balance: { increment: amount } },
    });
    await this.ledger.record(from, amount);
    const [{ balance }] = await this.db.$cypher<{ balance: number }>`
      MATCH (a:NxAccount {owner: ${from}}) RETURN a.balance AS balance`;
    if (balance < 0) throw new Error("insufficient funds");
  }

  async balances() {
    const rows = await this.db.nxAccount.findMany({ orderBy: { owner: "asc" } });
    return Object.fromEntries(rows.map((a) => [a.owner, a.balance]));
  }

  async transfers() {
    return this.db.nxTransfer.count();
  }
}

describe.skipIf(skip)("@cyphra/nestjs (Neo4j)", () => {
  let ref: TestingModule;
  let bank: BankService;
  const wipe = (db: Db) => db.$cypher`MATCH (n) WHERE n:NxAccount OR n:NxTransfer DETACH DELETE n`;

  beforeAll(async () => {
    ref = await Test.createTestingModule({
      imports: [
        TerminusModule.forRoot({ logger: false }),
        CyphraModule.forRootAsync({ useFactory: connect }),
      ],
      providers: [LedgerService, BankService],
    }).compile();
    await ref.init();
    bank = ref.get(BankService);
  });

  beforeEach(async () => {
    await wipe(bank.db);
    await bank.db.nxAccount.create({ data: { owner: "alice", balance: 100 } });
    await bank.db.nxAccount.create({ data: { owner: "bob", balance: 0 } });
  });

  afterAll(async () => {
    if (!ref) return;
    await wipe(bank.db);
    await ref.close();
  });

  it("commits the method and the services it calls together", async () => {
    await bank.transfer("alice", "bob", 30);
    expect(await bank.balances()).toEqual({ alice: 70, bob: 30 });
    expect(await bank.transfers()).toBe(1);
  });

  it("rolls everything back when the method throws", async () => {
    await expect(bank.transfer("alice", "bob", 150)).rejects.toThrow("insufficient funds");
    expect(await bank.balances()).toEqual({ alice: 100, bob: 0 });
    expect(await bank.transfers()).toBe(0);
  });

  it("sees its own uncommitted writes, which others do not see until commit", async () => {
    const outside = connect();
    try {
      let seenOutside: number | undefined;
      await bank.db.$transaction(async () => {
        await bank.transfer("alice", "bob", 10); // joins this transaction
        expect(await bank.balances()).toEqual({ alice: 90, bob: 10 });
        const a = await outside.nxAccount.findUnique({ where: { owner: "alice" } });
        seenOutside = a?.balance;
      });
      expect(seenOutside).toBe(100);
      expect(await bank.balances()).toEqual({ alice: 90, bob: 10 });
    } finally {
      await outside.$disconnect();
    }
  });

  it("reports the database up through Terminus", async () => {
    const health = ref.get(HealthCheckService);
    const indicator = ref.get(CyphraHealthIndicator);
    await expect(health.check([() => indicator.isHealthy("neo4j")])).resolves.toMatchObject({
      status: "ok",
      details: { neo4j: { status: "up" } },
    });
  });

  it("reports an unreachable database down", async () => {
    const down = await Test.createTestingModule({
      imports: [
        CyphraModule.forRoot({
          connection: "down",
          isGlobal: false,
          client: () =>
            createClient({
              uri: "bolt://127.0.0.1:1",
              user: "neo4j",
              password: "x",
              driverConfig: { connectionAcquisitionTimeout: 2000, maxConnectionPoolSize: 1 },
            }),
        }),
      ],
    }).compile();
    await down.init();
    await expect(
      down.get(CyphraHealthIndicator).isHealthy("neo4j", { connection: "down", timeout: 3000 }),
    ).resolves.toMatchObject({ neo4j: { status: "down" } });
    await down.close();
  });

  it("closes the driver when the application closes", async () => {
    const own = await Test.createTestingModule({
      imports: [CyphraModule.forRoot({ client: connect, isGlobal: false })],
    }).compile();
    await own.init();
    const db = own.get<Db>(getCyphraToken());
    await expect(db.$cypher`RETURN 1 AS one`).resolves.toEqual([{ one: 1 }]);
    await own.close();
    await expect(db.$cypher`RETURN 1 AS one`).rejects.toThrow();
  });
});
