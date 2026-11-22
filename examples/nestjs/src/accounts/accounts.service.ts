import { InjectCyphra, Transactional } from "@cyphra/nestjs";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { NotFoundError } from "cyphra";
import type { Db } from "../cyphra.gen.js";
import { LedgerService } from "./ledger.service.js";

@Injectable()
export class AccountsService {
  constructor(
    @InjectCyphra() private readonly db: Db,
    private readonly ledger: LedgerService,
  ) {}

  open(owner: string, balance = 0) {
    return this.db.account.create({ data: { owner, balance } });
  }

  list() {
    return this.db.account.findMany({ orderBy: { owner: "asc" } });
  }

  async get(owner: string) {
    const account = await this.db.account.findUnique({ where: { owner } });
    if (!account) throw new NotFoundException(`No account for ${owner}.`);
    return { ...account, transfers: await this.ledger.history(owner) };
  }

  /**
   * Debit, credit and ledger entry commit together. When the balance would go negative, the
   * method throws and none of it is written, including the entry LedgerService made.
   */
  @Transactional()
  async transfer(from: string, to: string, amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException("amount must be a positive integer.");
    }
    try {
      const debited = await this.db.account.update({
        where: { owner: from },
        data: { balance: { decrement: amount } },
      });
      await this.db.account.update({
        where: { owner: to },
        data: { balance: { increment: amount } },
      });
      const transfer = await this.ledger.record(from, to, amount);
      if (debited.balance < 0) throw new BadRequestException(`Insufficient funds on ${from}.`);
      return transfer;
    } catch (e) {
      if (e instanceof NotFoundError) throw new NotFoundException(e.message);
      throw e;
    }
  }
}
