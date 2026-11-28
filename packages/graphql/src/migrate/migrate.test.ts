import { parse, print, validate } from "graphql";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compareResults } from "./compare.js";
import { createMigrationContext } from "./context.js";
import { translateDocument, Unmapped } from "./operations.js";
import { draftRules } from "./rules.js";

const TYPEDEFS = /* GraphQL */ `
  type JWT @jwt {
    roles: [String!] @jwtClaim(path: "app.roles")
  }

  type Movie
    @node
    @fulltext(indexes: [{ indexName: "movieTitle", queryName: "moviesByTitle", fields: ["title"] }])
    @authorization(
      filter: [
        {
          operations: [READ]
          requireAuthentication: false
          where: { node: { published: { eq: true } } }
        }
        { where: { jwt: { roles: { includes: "admin" } } } }
      ]
      validate: [{ operations: [CREATE], where: { jwt: { roles: { includes: "editor" } } } }]
    ) {
    id: ID! @id
    title: String!
    released: Int
    published: Boolean!
    genres: [String!]!
    actors: [Person!]! @relationship(type: "ACTED_IN", direction: IN, properties: "ActedIn")
    studio: Studio @relationship(type: "MADE", direction: IN)
    score: Int @cypher(statement: "RETURN 1 AS s", columnName: "s")
  }

  type Person
    @node
    @authorization(
      filter: [{ operations: [UPDATE, DELETE], where: { node: { id: { eq: "$jwt.sub" } } } }]
    ) {
    id: ID! @id
    name: String!
    email: String @authorization(filter: [{ where: { node: { id: { eq: "$jwt.sub" } } } }])
    movies: [Movie!]! @relationship(type: "ACTED_IN", direction: OUT, properties: "ActedIn")
  }

  type Studio @node {
    id: ID! @id
    name: String!
    movies: [Movie!]! @relationship(type: "MADE", direction: OUT)
  }

  type ActedIn @relationshipProperties {
    role: String
  }

  union Credit = Movie | Studio
`;

const ctx = createMigrationContext({ typeDefs: TYPEDEFS });

/** The translated document, checked to validate against the native schema. */
function native(source: string): string {
  const t = translateDocument(ctx, source, { comments: false });
  expect(t.issues.filter((i) => i.kind === "blocking")).toEqual([]);
  expect(t.status).toBe("translated");
  expect(validate(ctx.nativeSchema, parse(t.output))).toEqual([]);
  return t.output;
}

function blocked(source: string): string[] {
  const t = translateDocument(ctx, source);
  expect(t.status).toBe("blocked");
  return t.issues.filter((i) => i.kind === "blocking").map((i) => i.message);
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
/** Both documents printed the same way. */
const doc = (s: string) => print(parse(s));

describe("translateDocument: queries", () => {
  it("renames root lists and translates filters, sorting and paging", () => {
    const out = native(
      `{
      movies(
        where: { title: { eq: "Up" }, released_GTE: 2000, released_LT: 2010, genres: { includes: "x" }, tagline_missing: null }
        sort: [{ released: DESC, title: ASC }]
        limit: 2
        offset: 1
      ) { title }
    }`.replace(", tagline_missing: null", ""),
    );
    expect(doc(out)).toBe(
      doc(`{
        movieFindMany(
          where: {title: {equals: "Up"}, released: {gte: 2000, lt: 2010}, genres: {has: "x"}}
          orderBy: [{released: desc}, {title: asc}]
          take: 2
          skip: 1
        ) { nodes { title } }
      }`),
    );
  });

  it("translates eq null, quantifiers (all needs a related node, empty filters are ignored) and single", () => {
    const out = native(`{
      movies(where: {
        released: { eq: null }
        actors: { some: {}, all: { name: { startsWith: "A" } }, none: { name: { eq: "B" } } }
        studio: { name: { eq: "Pixar" } }
        OR: [{ actors: { single: { name: { eq: "C" } } } }, { studio: null }]
      }) { id }
    }`);
    expect(flat(out)).toContain(
      flat(`where: {released: null, actors: {every: {name: {startsWith: "A"}}, none: {name: {equals: "B"}}, some: {}},
      studio: {is: {name: {equals: "Pixar"}}},
      OR: [{_count: {actors: {equals: 1, where: {name: {equals: "C"}}}}}, {studio: null}]}`),
    );
  });

  it("translates aggregation count filters to _count and blocks the others", () => {
    expect(
      flat(native(`{ movies(where: { actorsAggregate: { count: { gt: 2 } } }) { id } }`)),
    ).toContain("where: {_count: {actors: {gt: 2}}}");
    expect(
      flat(
        native(
          `{ movies(where: { actorsConnection: { aggregate: { count: { nodes: { lte: 1 } } } } }) { id } }`,
        ),
      ),
    ).toContain("where: {_count: {actors: {lte: 1}}}");
    expect(
      blocked(
        `{ movies(where: { actorsConnection: { aggregate: { node: { name: { shortestLength: { lt: 3 } } } } } }) { id } }`,
      )[0],
    ).toMatch(/aggregation filters on related node fields have no native equivalent/);
  });

  it("reads connections as relations with _edge and _count, aliasing what would collide", () => {
    const out = native(`{
      movies {
        actors { name }
        actorsConnection(where: { node: { name: { eq: "A" } } }, sort: [{ node: { name: ASC } }], first: 3) {
          totalCount
          edges { properties { role } node { name } }
        }
      }
    }`);
    expect(doc(out)).toBe(
      doc(`{
        movieFindMany { nodes {
          actors { name }
          actorsConnection: actors(where: {name: {equals: "A"}}, orderBy: [{name: asc}], take: 3) { name _edge { role } }
          _count { actors(where: {name: {equals: "A"}}) }
        } }
      }`),
    );
  });

  it("splits a root connection into findMany and aggregate", () => {
    const out = native(`{
      moviesConnection(first: 1, where: { published: { eq: true } }) {
        totalCount
        edges { node { title } }
        pageInfo { hasNextPage endCursor }
        aggregate { count { nodes } node { released { min average } title { longest } } }
      }
    }`);
    expect(doc(out)).toBe(
      doc(`{
        movieFindMany(take: 1, where: {published: {equals: true}}) {
          nodes { title } totalCount pageInfo { hasNextPage endCursor }
        }
        moviesConnectionAggregate: movieAggregate(where: {published: {equals: true}}) {
          _count { _all } _min { released } _avg { released }
        }
      }`),
    );
    const t = translateDocument(
      ctx,
      `{ moviesConnection { aggregate { node { title { longest } } } } }`,
    );
    expect(t.status).toBe("blocked");
  });

  it("translates full-text queries, unions and fragments", () => {
    expect(
      doc(
        native(
          `{ moviesByTitle(phrase: "toy", where: { score: { min: 0.5 } }, first: 5) { edges { score node { title } } } }`,
        ),
      ),
    ).toBe(
      doc(
        `{ movieSearch(index: movieTitle, query: "toy", mode: lucene, minScore: 0.5, take: 5) { title _score } }`,
      ),
    );
    const out = native(`
      query Credits { credits(where: { Movie: { title: { eq: "Up" } } }) { ...On } }
      fragment On on Credit { __typename ... on Movie { title } ... on Studio { name } }
    `);
    expect(flat(out)).toContain(
      'creditFindMany(where: {_on: {Movie: {title: {equals: "Up"}}}}) { nodes { ...On } }',
    );
  });

  it("retypes variables and drops the ones no longer used", () => {
    const out = native(
      `query ($t: String!, $n: Int) { movies(where: { title: { eq: $t } }, limit: $n) { title score } }`,
    );
    expect(flat(out)).toContain("query ($t: String!, $n: Int)");
    const t = translateDocument(
      ctx,
      `query ($x: Int) { movies { score(x: $x) } }`.replace("(x: $x)", ""),
    );
    expect(t.status).toBe("invalid");
  });

  it("blocks what has no native equivalent, with the place and a comment", () => {
    const t = translateDocument(
      ctx,
      `query Q($w: MovieWhere) {\n  movies(where: $w) { title }\n}\n`,
    );
    expect(t.status).toBe("blocked");
    expect(t.output).toBe(
      `# cyphra: not translated: movies(where): the variable $w holds a v7 MovieWhere; write the filter inline (or build the native where in the client)\nquery Q($w: MovieWhere) {\n  movies(where: $w) { title }\n}\n`,
    );
    // Run again: the comments are replaced, not repeated.
    expect(translateDocument(ctx, t.output).output).toBe(t.output);
    expect(
      blocked(
        `{ movies(where: { actorsConnection: { some: { edge: { role: { eq: "x" } } } } }) { id } }`,
      )[0],
    ).toMatch(/no filters on edge properties/);
  });

  it("drops what a selection cannot have, with a note", () => {
    const t = translateDocument(ctx, `{ movies { title score } }`);
    expect(t.status).toBe("translated");
    expect(t.output).toMatch(
      /^# cyphra: movies.score: dropped: the @cypher field Movie.score is not in the native API/,
    );
  });

  it("recognizes native documents and invalid ones", () => {
    expect(translateDocument(ctx, `{ movieFindMany { nodes { title } } }`).status).toBe("native");
    expect(translateDocument(ctx, `{ nope }`).status).toBe("invalid");
    expect(translateDocument(ctx, `{ movies {`).status).toBe("invalid");
  });
});

describe("translateDocument: mutations", () => {
  it("translates creates with nested creates and connects by unique key", () => {
    const out = native(`mutation {
      createMovies(input: [{
        title: "Up", published: true, genres: []
        actors: { create: [{ node: { name: "Ed" }, edge: { role: "Carl" } }], connect: [{ where: { node: { id: { eq: "p1" } } }, edge: { role: "x" } }] }
      }]) { info { nodesCreated } movies { title } }
    }`);
    expect(doc(out)).toBe(
      doc(`mutation {
        movieCreate(data: {title: "Up", published: true, genres: [],
          actors: {create: [{name: "Ed", _edge: {role: "Carl"}}], connect: [{id: "p1", _edge: {role: "x"}}]}}) { title }
      }`),
    );
    const t = translateDocument(
      ctx,
      `mutation { createMovies(input: [{ title: "a", published: true, genres: [], actors: { connect: [{ where: { node: { name: { eq: "Ed" } } } }] } }]) { info { nodesCreated } } }`,
    );
    expect(t.issues.map((i) => i.message).join("\n")).toMatch(/connect by a non-unique where/);
  });

  it("translates batches, updates with _ops and deletes", () => {
    expect(
      doc(
        native(
          `mutation { createPeople(input: [{ name: "a" }, { name: "b" }]) { info { nodesCreated } people { name } } }`,
        ),
      ),
    ).toBe(
      doc(
        `mutation { personCreateMany(data: [{name: "a"}, {name: "b"}]) { count nodes { name } } }`,
      ),
    );
    expect(
      doc(
        native(
          `mutation { updateMovies(where: { released: { lt: 2000 } }, update: { title: { set: "Old" }, released: { add: 1 } }) { movies { title } } }`,
        ),
      ),
    ).toBe(
      doc(
        `mutation { movieUpdateMany(where: {released: {lt: 2000}}, data: {title: "Old", _ops: {released: {increment: 1}}}) { nodes { title } } }`,
      ),
    );
    expect(
      doc(
        native(
          `mutation { updateMovies(where: { id: { eq: "m1" } }, update: { actors: [{ disconnect: [{ where: { node: { id: { eq: "p1" } } } }] }] }) { movies { id } } }`,
        ),
      ),
    ).toBe(
      doc(
        `mutation { movieUpdate(where: {id: "m1"}, data: {actors: {disconnect: [{id: "p1"}]}}) { id } }`,
      ),
    );
    expect(
      doc(native(`mutation { deleteMovies(where: { title: { eq: "x" } }) { nodesDeleted } }`)),
    ).toBe(doc(`mutation { movieDeleteMany(where: {title: {equals: "x"}}) { count } }`));
    expect(
      blocked(
        `mutation { deleteMovies(where: {}, delete: { actors: [{ where: {} }] }) { nodesDeleted } }`,
      )[0],
    ).toMatch(/onDelete: Cascade/);
    expect(
      blocked(
        `mutation { updateMovies(update: { genres: { push: ["x"] } }) { movies { id } } }`,
      )[0],
    ).toMatch(/push has no native equivalent/);
  });

  it("blocks writes the native config does not serve", () => {
    const readOnly = createMigrationContext({ typeDefs: TYPEDEFS, config: {} });
    const t = translateDocument(readOnly, `mutation { deleteMovies { nodesDeleted } }`);
    expect(t.issues[0]?.message).toMatch(
      /does not serve movieDeleteMany \(turn on Movie's deleteMany operation/,
    );
  });
});

describe("mapData and compareResults", () => {
  it("maps a v7 result to the native shape", () => {
    const t = translateDocument(
      ctx,
      `{
      moviesConnection(first: 1) { totalCount edges { node { title actorsConnection { totalCount edges { properties { role } node { name } } } } } pageInfo { endCursor hasNextPage } }
    }`,
    );
    const def = t.definitions[0]!;
    const mapped = def.mapData!({
      moviesConnection: {
        totalCount: 2,
        edges: [
          {
            node: {
              title: "Up",
              actorsConnection: {
                totalCount: 1,
                edges: [{ properties: { role: "Carl" }, node: { name: "Ed" } }],
              },
            },
          },
        ],
        pageInfo: { endCursor: "YXJyYXljb25uZWN0aW9uOjA=", hasNextPage: true },
      },
    });
    expect(mapped).toEqual({
      movieFindMany: {
        nodes: [
          { title: "Up", actors: [{ name: "Ed", _edge: { role: "Carl" } }], _count: { actors: 1 } },
        ],
        totalCount: 2,
        pageInfo: { endCursor: expect.any(Unmapped), hasNextPage: true },
      },
    });
    const same = {
      data: {
        movieFindMany: {
          nodes: [
            {
              title: "Up",
              actors: [{ name: "Ed", _edge: { role: "Carl" } }],
              _count: { actors: 1 },
            },
          ],
          totalCount: 2,
          pageInfo: { endCursor: "WzBd", hasNextPage: true },
        },
      },
    };
    const v7 = {
      data: {
        moviesConnection: {
          totalCount: 2,
          edges: [
            {
              node: {
                title: "Up",
                actorsConnection: {
                  totalCount: 1,
                  edges: [{ properties: { role: "Carl" }, node: { name: "Ed" } }],
                },
              },
            },
          ],
          pageInfo: { endCursor: "YXJyYXljb25uZWN0aW9uOjA=", hasNextPage: true },
        },
      },
    };
    const diffs = compareResults(def, v7, same);
    expect(diffs.every((d) => d.known)).toBe(true);
    const other = structuredClone(same);
    other.data.movieFindMany.totalCount = 3;
    expect(compareResults(def, v7, other).filter((d) => !d.known)).toEqual([
      { path: "movieFindMany.totalCount", v7: 2, native: 3 },
    ]);
  });

  it("compares lists as multisets unless ordered", () => {
    const t = translateDocument(ctx, `{ movies { title } }`);
    const def = t.definitions[0]!;
    const v7 = { data: { movies: [{ title: "a" }, { title: "b" }] } };
    const n = { data: { movieFindMany: { nodes: [{ title: "b" }, { title: "a" }] } } };
    expect(compareResults(def, v7, n)).toEqual([]);
    expect(compareResults(def, v7, n, { ordered: true })).toHaveLength(2);
    expect(compareResults(def, { errors: [{ message: "Forbidden" }] }, n)[0]?.path).toBe("errors");
  });

  it("compares errors on extensions.code, message and path (#310)", () => {
    const def = translateDocument(ctx, `{ movies { title } }`).definitions[0]!;
    const error = (code: string, path: (string | number)[]) => ({
      message: "Unauthenticated",
      path,
      extensions: { code },
    });
    // `movies: [Movie!]!` is non-null in v7: its error nulls the whole data.
    const v7 = { data: null, errors: [error("UNAUTHENTICATED", ["movies"])] };
    const native = (code: string, path: (string | number)[] = ["movieFindMany"]) => ({
      data: { movieFindMany: null },
      errors: [error(code, path)],
    });
    const failing = (r: ReturnType<typeof compareResults>) => r.filter((d) => !d.known);
    // The same error, at the mapped root field.
    expect(failing(compareResults(def, v7, native("UNAUTHENTICATED")))).toEqual([]);
    // Same message and path, another code.
    expect(failing(compareResults(def, v7, native("FORBIDDEN")))).toEqual([
      { path: "errors[0].extensions.code", v7: "UNAUTHENTICATED", native: "FORBIDDEN" },
    ]);
    // Another message.
    const other = native("UNAUTHENTICATED");
    expect(
      failing(
        compareResults(def, v7, { ...other, errors: [{ ...other.errors[0]!, message: "Nope" }] }),
      ),
    ).toEqual([{ path: "errors[0].message", v7: "Unauthenticated", native: "Nope" }]);
    // A field error mapped through the connection shape, and one at another field.
    const field = {
      data: { movies: [{ title: null }] },
      errors: [error("X", ["movies", 0, "title"])],
    };
    const at = (path: (string | number)[]) => ({
      data: { movieFindMany: { nodes: [{ title: null }] } },
      errors: [error("X", path)],
    });
    expect(compareResults(def, field, at(["movieFindMany", "nodes", 0, "title"]))).toEqual([]);
    expect(compareResults(def, field, at(["movieFindMany"]))).toEqual([
      { path: "errors[0].path", v7: ["movies", 0, "title"], native: ["movieFindMany"] },
    ]);
  });
});

describe("draftRules", () => {
  const draft = draftRules(ctx);

  it("drafts what the native API can express and leaves TODOs for the rest", () => {
    expect(draft.code).toContain(
      `read: ({ ctx }) => anyOf({ published: { equals: true } }, allOf(authenticated(ctx), claim(ctx.jwt?.app?.roles, "INCLUDES", "admin"))),`,
    );
    expect(draft.code).toContain(
      `create: ({ ctx }) => allOf(authenticated(ctx), claim(ctx.jwt?.app?.roles, "INCLUDES", "editor")) === true,`,
    );
    expect(draft.code).toContain(
      `update: ({ ctx }) => allOf(authenticated(ctx), { AND: [given(ctx.jwt?.sub, (v0) => ({ id: { equals: v0 } }))] }),`,
    );
    expect(draft.code).toMatch(/TODO\(cyphra\): v7 field filter on Person\.email/);
    expect(draft.entries.find((e) => e.target === "Person.email")?.status).toBe("todo");
    expect(draft.drafted + draft.partial + draft.todo).toBe(draft.entries.length);
  });

  it("prints a module whose rules behave like the v7 rules", async () => {
    const js = ts.transpileModule(
      draft.code.replace(
        /^import \{ defineGraphQL \} from "@cyphra\/graphql";$/m,
        "const defineGraphQL = (c) => c;",
      ),
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const mod = (await import(`data:text/javascript,${encodeURIComponent(js)}`)) as {
      default: {
        models: Record<string, { rules: Record<string, (a: { ctx: unknown }) => unknown> }>;
      };
    };
    const { Movie, Person } = mod.default.models;
    const admin = { jwt: { sub: "u1", app: { roles: ["admin"] } } };
    expect(Movie!.rules.read!({ ctx: {} })).toEqual({ published: { equals: true } });
    expect(Movie!.rules.read!({ ctx: admin })).toBe(true);
    expect(Movie!.rules.create!({ ctx: admin })).toBe(false);
    expect(Movie!.rules.create!({ ctx: { jwt: { app: { roles: ["editor"] } } } })).toBe(true);
    // A missing claim matches nothing, as in v7.
    expect(Person!.rules.update!({ ctx: { jwt: {} } })).toEqual({ AND: [{ OR: [] }] });
    expect(Person!.rules.update!({ ctx: {} })).toBe(false);
    expect(Person!.rules.delete!({ ctx: admin })).toEqual({ AND: [{ id: { equals: "u1" } }] });
  });

  it("typechecks against the native config types", () => {
    const root = new URL("../../..", import.meta.url).pathname;
    const file = `${root}graphql/src/migrate/__draft__.ts`;
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      // Absolute paths, no `baseUrl` (deprecated in TypeScript 6).
      paths: {
        "@cyphra/graphql": [`${root}graphql/src/index.ts`],
        cyphra: [`${root}runtime/src/index.ts`],
      },
    };
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host);
    host.readFile = (f) => (f === file ? draft.code : read(f));
    const exists = host.fileExists.bind(host);
    host.fileExists = (f) => f === file || exists(f);
    const program = ts.createProgram([file], options, host);
    const errors = ts
      .getPreEmitDiagnostics(program, program.getSourceFile(file))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(errors).toEqual([]);
  }, 60_000);
});
