import { Module } from "@nestjs/common";
import { AccountsController } from "./accounts.controller.js";
import { AccountsService } from "./accounts.service.js";
import { LedgerService } from "./ledger.service.js";

@Module({
  controllers: [AccountsController],
  providers: [AccountsService, LedgerService],
})
export class AccountsModule {}
