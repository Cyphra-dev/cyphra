import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { defineFactory, resetSequences, type FactoryClient } from "../src/index.js";
import type { CyphraTypeMap, TstUser } from "./fixtures/shop.gen.js";
import { admins, posts, tags, users } from "./factories.js";

/** A client stub that records `create` calls and returns the data. */
function stubClient() {
  const calls: { model: string; data: unknown }[] = [];
  const delegate = (model: string) => ({
    create: async ({ data }: { data: unknown }) => {
      calls.push({ model, data });
      return data;
    },
  });
  return { calls, db: { tstUser: delegate("TstUser"), tstPost: delegate("TstPost") } };
}

beforeEach(() => resetSequences());

describe("defineFactory", () => {
  it("builds records from defaults with a sequence", () => {
    expect(users.build()).toEqual({ email: "user1@example.com", name: "User 1" });
    expect(users.build({ name: "Ada" })).toEqual({ email: "user2@example.com", name: "Ada" });
    expect(users.buildList(2, ({ sequence }) => ({ name: `#${sequence}` }))).toEqual([
      { email: "user3@example.com", name: "#3" },
      { email: "user4@example.com", name: "#4" },
    ]);
  });

  it("resets sequences, per factory or all at once", () => {
    users.build();
    users.build();
    tags.build();
    users.resetSequence();
    expect(users.build().email).toBe("user1@example.com");
    expect(tags.build().name).toBe("tag-2");
    resetSequences();
    expect(tags.build().name).toBe("tag-1");
  });

  it("extends defaults and shares the sequence", () => {
    expect(admins.build()).toEqual({ email: "user1@example.com", name: "User 1", role: "admin" });
    expect(users.build().email).toBe("user2@example.com");
    expect(admins.build({ role: "owner" }).role).toBe("owner");
  });

  it("writes relations: nested creates and connects", () => {
    expect(posts.build()).toEqual({
      title: "Post 1",
      author: { create: { email: "user1@example.com", name: "User 1" } },
    });
    expect(posts.build({ author: users.connect({ id: "u1" }), tags: tags.nestedList(2) })).toEqual({
      title: "Post 2",
      author: { connect: { id: "u1" } },
      tags: { create: [{ name: "tag-1" }, { name: "tag-2" }] },
    });
    // The overridden lazy author was not built: the user sequence did not move.
    expect(users.build().email).toBe("user2@example.com");
  });

  it("creates through the model delegate of the client it is given", async () => {
    const { calls, db } = stubClient();
    await users.create(db, { name: "Ada" });
    await posts.createList(db, 2);
    expect(calls.map((c) => c.model)).toEqual(["TstUser", "TstPost", "TstPost"]);
    expect(calls[0]!.data).toEqual({ email: "user1@example.com", name: "Ada" });
    await expect(tags.create(db as never)).rejects.toThrow(/no "tstTag" model/);
  });

  it("is typed by the generated type map", async () => {
    const standalone = defineFactory<CyphraTypeMap, "TstTag">("TstTag", { name: "x" });
    expectTypeOf(standalone.build()).toHaveProperty("name");
    // @ts-expect-error: `name` is required on TstUser
    defineFactory<CyphraTypeMap, "TstUser">("TstUser", { email: "a@example.com" });
    // @ts-expect-error: no such model
    defineFactory<CyphraTypeMap, "Nope">("Nope", {});
    // @ts-expect-error: unknown field
    users.build({ nickname: "x" });
    const { db } = stubClient();
    const created = await users.create(db as FactoryClient<CyphraTypeMap, "TstUser">);
    expectTypeOf(created).toEqualTypeOf<TstUser>();
  });
});
