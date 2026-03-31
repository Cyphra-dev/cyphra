import { describe, expect, it } from "vitest";
import { eq, prop } from "./builder.js";
import {
  buildReturnRawFieldsMap,
  compileCreateLinkedNodes,
  compileRootOptionalOutgoingSelect,
  compileRootWithOptionalOut,
} from "./graphQuery.js";
import { normalizeCypher } from "./spec/normalizeCypher.js";

describe("graphQuery", () => {
  it("buildReturnRawFieldsMap merges map projections and scalars", () => {
    const fields = buildReturnRawFieldsMap({
      maps: [{ resultKey: "post", variable: "p", pick: ["id", "title"] }],
      scalars: { authorName: { variable: "a", property: "name" } },
    });
    expect(fields).toEqual({
      post: "p { .id, .title }",
      authorName: "a.name",
    });
  });

  it("compileRootOptionalOutgoingSelect matches blog-style list query", () => {
    const got = compileRootOptionalOutgoingSelect({
      rootLabel: "Post",
      rootAlias: "p",
      outgoing: {
        relType: "WRITTEN_BY",
        relAlias: "r",
        targetLabel: "Author",
        targetAlias: "a",
      },
      returnMaps: [
        { resultKey: "post", variable: "p", pick: ["id", "title", "slug", "createdAt"] },
      ],
      scalars: { authorName: { variable: "a", property: "name" } },
      orderBy: { variable: "p", property: "createdAt", direction: "DESC" },
    });
    expect(normalizeCypher(got.text)).toBe(
      normalizeCypher(
        "MATCH (p:Post) OPTIONAL MATCH (p:Post)-[r:WRITTEN_BY]->(a:Author) RETURN p { .id, .title, .slug, .createdAt } AS post, a.name AS authorName ORDER BY p.createdAt DESC",
      ),
    );
    expect(got.params).toEqual({});
  });

  it("compileRootOptionalOutgoingSelect supports WHERE + LIMIT", () => {
    const got = compileRootOptionalOutgoingSelect({
      rootLabel: "Post",
      rootAlias: "p",
      outgoing: {
        relType: "WRITTEN_BY",
        relAlias: "r",
        targetLabel: "Author",
        targetAlias: "a",
      },
      returnMaps: [
        { resultKey: "post", variable: "p", pick: ["id", "title", "slug", "body", "createdAt"] },
      ],
      scalars: { authorName: { variable: "a", property: "name" } },
      where: [eq(prop("p", "slug"), "x")],
      limit: 1,
    });
    expect(normalizeCypher(got.text)).toBe(
      normalizeCypher(
        "MATCH (p:Post) OPTIONAL MATCH (p:Post)-[r:WRITTEN_BY]->(a:Author) WHERE p.slug = $p0 RETURN p { .id, .title, .slug, .body, .createdAt } AS post, a.name AS authorName LIMIT toInteger($p1)",
      ),
    );
    expect(got.params).toEqual({ p0: "x", p1: 1 });
  });

  it("compileRootWithOptionalOut matches verbose compileRootOptionalOutgoingSelect", () => {
    const verbose = compileRootOptionalOutgoingSelect({
      rootLabel: "Post",
      rootAlias: "n",
      outgoing: {
        relType: "WRITTEN_BY",
        relAlias: "r",
        targetLabel: "Author",
        targetAlias: "a",
      },
      returnMaps: [
        { resultKey: "root", variable: "n", pick: ["id", "title", "slug", "body", "createdAt"] },
        { resultKey: "included", variable: "a", pick: ["id", "name"] },
      ],
      where: [eq(prop("n", "slug"), "x")],
      limit: 1,
    });
    const easy = compileRootWithOptionalOut({
      root: { label: "Post", pick: ["id", "title", "slug", "body", "createdAt"] },
      optionalRelationship: {
        type: "WRITTEN_BY",
        targetLabel: "Author",
        pick: ["id", "name"],
      },
      whereRootEq: { slug: "x" },
      limit: 1,
    });
    expect(normalizeCypher(easy.text)).toBe(normalizeCypher(verbose.text));
    expect(easy.params).toEqual(verbose.params);
  });

  it("compileRootOptionalOutgoingSelect supports SKIP before LIMIT", () => {
    const got = compileRootOptionalOutgoingSelect({
      rootLabel: "Post",
      rootAlias: "p",
      returnMaps: [{ resultKey: "post", variable: "p", pick: ["id"] }],
      skip: 5,
      limit: 10,
    });
    expect(normalizeCypher(got.text)).toBe(
      normalizeCypher(
        "MATCH (p:Post) RETURN p { .id } AS post SKIP toInteger($p0) LIMIT toInteger($p1)",
      ),
    );
    expect(got.params).toEqual({ p0: 5, p1: 10 });
  });

  it("compileCreateLinkedNodes concatenates CREATE + relationship with remapped params", () => {
    const got = compileCreateLinkedNodes({
      primary: {
        label: "Post",
        alias: "p",
        props: { id: "pid", title: "t", slug: "s", body: "b" },
        serverTimestamp: "createdAt",
      },
      secondary: { label: "Author", alias: "a", props: { id: "aid", name: "Alice" } },
      link: { type: "WRITTEN_BY", alias: "r" },
    });
    expect(normalizeCypher(got.text)).toBe(
      normalizeCypher(
        "CREATE (p:Post) SET p += $props, p.createdAt = datetime() CREATE (a:Author) SET a += $f1_props CREATE (p)-[r:WRITTEN_BY]->(a)",
      ),
    );
    expect(got.params).toEqual({
      props: { id: "pid", title: "t", slug: "s", body: "b" },
      f1_props: { id: "aid", name: "Alice" },
    });
  });

  it("compileCreateLinkedNodes single primary with serverTimestamp", () => {
    const got = compileCreateLinkedNodes({
      primary: {
        label: "Post",
        alias: "p",
        props: { id: "i" },
        serverTimestamp: "createdAt",
      },
    });
    expect(got.text).toBe("CREATE (p:Post) SET p += $props, p.createdAt = datetime()");
    expect(got.params).toEqual({ props: { id: "i" } });
  });
});
