import { InjectCyphra } from "@cyphra/nestjs";
import { Injectable } from "@nestjs/common";
import type { Db } from "../cyphra.gen.js";

/** Records transfers. Called from a @Transactional() method, it writes in that transaction. */
@Injectable()
export class LedgerService {
  constructor(@InjectCyphra() private readonly db: Db) {}

  record(from: string, to: string, amount: number) {
    return this.db.transfer.create({
      data: {
        amount,
        from: { connect: { owner: from } },
        to: { connect: { owner: to } },
      },
    });
  }

  history(owner: string) {
    return this.db.transfer.findMany({
      where: { OR: [{ from: { is: { owner } } }, { to: { is: { owner } } }] },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        amount: true,
        createdAt: true,
        from: { select: { owner: true } },
        to: { select: { owner: true } },
      },
    });
  }
}
