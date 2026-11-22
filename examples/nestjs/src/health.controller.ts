import { CyphraHealthIndicator } from "@cyphra/nestjs";
import { Controller, Get } from "@nestjs/common";
import { HealthCheck, HealthCheckService } from "@nestjs/terminus";

@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly cyphra: CyphraHealthIndicator,
  ) {}

  /** 200 `{ status: "ok", ... }` when Neo4j answers, 503 otherwise. */
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.cyphra.isHealthy("neo4j")]);
  }
}
