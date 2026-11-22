import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { AccountsService } from "./accounts.service.js";

@Controller("accounts")
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post()
  open(@Body() body: { owner: string; balance?: number }) {
    return this.accounts.open(body.owner, body.balance);
  }

  @Get()
  list() {
    return this.accounts.list();
  }

  @Get(":owner")
  get(@Param("owner") owner: string) {
    return this.accounts.get(owner);
  }

  @Post("transfers")
  transfer(@Body() body: { from: string; to: string; amount: number }) {
    return this.accounts.transfer(body.from, body.to, body.amount);
  }
}
