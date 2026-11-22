import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { CyphraHealthCheckError, CyphraHealthIndicator, CyphraModule } from "../src/index.js";
import { fakeClient } from "./fake-client.js";

// Terminus 10 has no HealthIndicatorService and only reads failures from rejected indicators.
vi.mock("@nestjs/terminus", () => ({ HealthCheckService: class {} }));

describe("CyphraHealthIndicator with @nestjs/terminus 10", () => {
  it("throws a health-check error when the database is down", async () => {
    const client = fakeClient();
    const ref = await Test.createTestingModule({
      imports: [CyphraModule.forRoot({ client })],
    }).compile();
    const indicator = ref.get(CyphraHealthIndicator);
    expect(await indicator.isHealthy("neo4j")).toEqual({ neo4j: { status: "up" } });

    client.failPing = new Error("connection refused");
    const error = await indicator.isHealthy("neo4j").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CyphraHealthCheckError);
    expect(error).toMatchObject({
      isHealthCheckError: true,
      causes: { neo4j: { status: "down", message: "connection refused" } },
    });
    await ref.close();
  });
});
