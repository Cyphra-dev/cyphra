import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CyphraConfig } from "../config.js";
import { runValidateSchema } from "./validateSchema.js";

const SCHEMA = `node User {
  id    String @id
  email String @unique @email
  name  String @length(2, 40) @nonEmpty
  age   Int?   @min(13)
}

relationship Follows {
  type "FOLLOWS"
  from User
  to User
  note String? @length(max: 280)
}
`;

describe("runValidateSchema", () => {
  let dir: string;
  let config: CyphraConfig;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-validate-"));
    config = {
      schema: join(dir, "schema.cyphra"),
      migrations: join(dir, "migrations"),
      generate: join(dir, "cyphra.gen.ts"),
      runtimeImport: "cyphra",
    };
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const output = () => log.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");

  it("lists the validation rules with --verbose", async () => {
    await writeFile(config.schema, SCHEMA);
    await runValidateSchema(dir, config, { verbose: true });
    expect(output()).toBe(
      [
        "OK — schema.cyphra (2 declaration(s))",
        "Validation rules (4 fields):",
        "  User.email    @email",
        "  User.name     @length(2, 40) @nonEmpty",
        "  User.age      @min(13)",
        "  Follows.note  @length(max: 280)",
      ].join("\n"),
    );
  });

  it("prints only the summary without --verbose, and says when there are no rules", async () => {
    await writeFile(config.schema, SCHEMA);
    await runValidateSchema(dir, config);
    expect(output()).toBe("OK — schema.cyphra (2 declaration(s))");
    log.mockClear();
    await writeFile(config.schema, "node A {\n  id String @id\n}\n");
    await runValidateSchema(dir, config, { verbose: true });
    expect(output()).toBe("OK — schema.cyphra (1 declaration(s))\nNo validation rules.");
  });

  it("rejects an invalid rule", async () => {
    await writeFile(config.schema, "node A {\n  id String @id\n  n Int @length(1)\n}\n");
    await expect(runValidateSchema(dir, config)).rejects.toThrow(
      'Node "A" field "n": @length is not valid on a Int field (only on String fields).',
    );
  });
});
