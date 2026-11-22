import type { OrmTransactionClient } from "cyphra";
import { describe, expectTypeOf, it } from "vitest";
import {
  CyphraModule,
  getTransaction,
  type CyphraClientLike,
  type CyphraTransaction,
} from "../src/index.js";
import { createClient, type CyphraTypeMap, type Db } from "./fixtures/db.gen.js";

// Checked by `tsc --noEmit` (pnpm typecheck); the runtime part only builds dynamic modules.
describe("types", () => {
  it("accepts generated and extended clients, and gives their transaction client", () => {
    expectTypeOf<Db>().toExtend<CyphraClientLike>();
    expectTypeOf<CyphraTransaction<Db>>().toEqualTypeOf<OrmTransactionClient<CyphraTypeMap>>();
    expectTypeOf(getTransaction<Db>()).toEqualTypeOf<
      OrmTransactionClient<CyphraTypeMap> | undefined
    >();

    const db = createClient({ uri: "bolt://localhost:7687", user: "neo4j", password: "x" });
    const extended = db.$extends({ client: { hello: () => "hi" } });
    expectTypeOf(extended).toExtend<CyphraClientLike>();
    CyphraModule.forRoot({ client: extended, closeOnShutdown: false });
    CyphraModule.forRootAsync({ useFactory: async () => db });
    void db.$disconnect();
  });
});
