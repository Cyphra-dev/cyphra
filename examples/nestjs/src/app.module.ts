import { CyphraModule } from "@cyphra/nestjs";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TerminusModule } from "@nestjs/terminus";
import { AccountsModule } from "./accounts/accounts.module.js";
import { createClient } from "./cyphra.gen.js";
import { HealthController } from "./health.controller.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // One client (one driver and connection pool) for the application, injectable everywhere
    // with @InjectCyphra(). It is closed when the application shuts down.
    CyphraModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createClient({
          uri: config.getOrThrow<string>("NEO4J_URI"),
          user: config.getOrThrow<string>("NEO4J_USERNAME"),
          password: config.getOrThrow<string>("NEO4J_PASSWORD"),
        }),
    }),
    TerminusModule,
    AccountsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
