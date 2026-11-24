import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGraphqlCheck } from "./graphqlCheck.js";

const USER = `type User @node {
  id: ID! @unique
  best: User! @relationship(type: "BEST", direction: OUT)
  posts: [Post!]! @relationship(type: "WROTE", direction: OUT)
}
`;
const POST = `scalar Upload
type Post @node {
  title: String @coalesce(value: "")
}
`;

describe("cyphra graphql check", () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-graphql-check-"));
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void err.push(String(m)));
    await writeFile(join(dir, "user.graphql"), USER);
    await writeFile(join(dir, "post.graphql"), POST);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists every issue of all the files and exits with 1", async () => {
    const code = await runGraphqlCheck(dir, ["user.graphql", "post.graphql"]);
    expect(code).toBe(1);
    expect(out.join("\n")).toBe(
      [
        "user.graphql:2:11  UNSUPPORTED  User.id: @unique is not supported by @cyphra/graphql yet.",
        'user.graphql:3:3   INVALID      User.best: Non-list relationship property "best" cannot have non-nullable type.',
        "post.graphql:1:1   UNSUPPORTED  scalar Upload: custom scalars are not supported by @cyphra/graphql yet.",
        "post.graphql:3:17  UNSUPPORTED  Post.title: @coalesce is not supported by @cyphra/graphql yet.",
        "",
        "4 issues in 2 files (3 unsupported by @cyphra/graphql, 1 invalid for @neo4j/graphql 7).",
      ].join("\n"),
    );
  });

  it("prints { files, issues } with --json", async () => {
    const code = await runGraphqlCheck(dir, ["user.graphql", "post.graphql"], { json: true });
    expect(code).toBe(1);
    const report = JSON.parse(out.join("\n")) as {
      files: string[];
      issues: { code: string; message: string; location: Record<string, unknown> }[];
    };
    expect(report.files).toEqual(["user.graphql", "post.graphql"]);
    expect(report.issues).toHaveLength(4);
    expect(report.issues[0]).toEqual({
      code: "UNSUPPORTED",
      message: "User.id: @unique is not supported by @cyphra/graphql yet.",
      location: { type: "User", field: "id", source: "user.graphql", line: 2, column: 11 },
    });
  });

  it("exits with 0 when makeSchema accepts the type definitions", async () => {
    await writeFile(join(dir, "ok.graphql"), "type Post @node { title: String }\n");
    expect(await runGraphqlCheck(dir, ["ok.graphql"])).toBe(0);
    expect(out).toEqual(["OK — compat.v7.makeSchema accepts the type definitions (1 file)."]);
    out = [];
    expect(await runGraphqlCheck(dir, ["ok.graphql"], { json: true })).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ files: ["ok.graphql"], issues: [] });
  });

  it("reports syntax errors and unreadable files", async () => {
    await writeFile(join(dir, "bad.graphql"), "type Post @node {\n");
    expect(await runGraphqlCheck(dir, ["bad.graphql"])).toBe(1);
    expect(out[0]).toBe("bad.graphql:2:1  SYNTAX  Syntax Error: Expected Name, found <EOF>.");
    expect(await runGraphqlCheck(dir, ["missing.graphql"])).toBe(1);
    expect(err).toEqual(["Cannot read missing.graphql."]);
  });
});
