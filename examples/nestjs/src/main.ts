import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

const app = await NestFactory.create(AppModule);
// SIGTERM / SIGINT close the application: CyphraModule then closes the Neo4j driver.
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? 3000));
console.log(`Listening on ${await app.getUrl()}`);
