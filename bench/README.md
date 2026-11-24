# cyphra-bench

Private workspace (not published). Reproducible benchmarks of the cost of the Cyphra layer: the
same operations through the raw `neo4j-driver` with hand-written Cypher (the baseline), the
Cyphra typed client over Bolt and over its HTTP transport, `@cyphra/graphql` against
`@neo4j/graphql`, and [neogma](https://github.com/themetalfleece/neogma).

Latest results: [`results/RESULTS.md`](results/RESULTS.md) (raw data in
[`results/latest.json`](results/latest.json)), published at
[cyphra.dev/benchmarks](https://www.cyphra.dev/benchmarks).

## Running

```sh
docker run -d --name cyphra-bench -p 127.0.0.1:17724:7687 -p 127.0.0.1:17484:7474 \
  --tmpfs /data:rw,size=4g -e NEO4J_AUTH=neo4j/cyphra_ci_test -e NEO4J_PLUGINS='["apoc"]' \
  -e NEO4J_server_memory_heap_max__size=2G neo4j:5-community

pnpm install
pnpm -r --filter './packages/*' run build
pnpm install --offline          # links the `cyphra` bin once packages/cli/dist exists

pnpm bench                      # full run (about 6 min): writes results/latest.json and RESULTS.md
pnpm bench --quick              # small data, a few iterations, writes nothing (what CI runs)
pnpm bench --only find-unique,traverse
pnpm bench --no-http            # skip the HTTP transport contenders
pnpm --filter cyphra-bench report   # rebuild RESULTS.md from latest.json
pnpm --filter cyphra-bench extends  # per-request $extends / withEngineRules cost (no database)

docker rm -f cyphra-bench
```

`--tmpfs /data` keeps the database in memory: without it, every write waits for the transaction
log to be flushed to disk, and on a shared machine that flush (several to hundreds of
milliseconds, depending on what else uses the disk) drowns the client-side differences this
benchmark is about. The published run uses it.

The run wipes and reseeds the `User`, `Post`, `Comment` and `Doc` labels of the database it points
at: use a disposable one. Connection settings come from `NEO4J_BENCH_URI`,
`NEO4J_BENCH_HTTP_URI`, `NEO4J_BENCH_USER`, `NEO4J_BENCH_PASSWORD` and `NEO4J_BENCH_DATABASE`
(falling back to the `NEO4J_TEST_*` variables of the integration tests, then to the container
above). APOC is needed by `@neo4j/graphql` for nested mutations.

`pnpm bench` compiles `src/` with esbuild and runs it with plain Node. Running the TypeScript
through `tsx` works too, but its module hooks make `@neo4j/graphql` and neogma take over a minute
to import.

## Method

**Data** (seeded with a fixed PRNG seed, so every run builds the same graph): 10,000 users, each
following 5 others (50,000 `FOLLOWS` edges); the first 2,000 users write 5 posts each (10,000
posts), each post has 2 comments (20,000 comments); 1,000 documents with a 384-dimension
embedding. The constraints and indexes are the ones `cyphra push` creates from
[`schema.cyphra`](schema.cyphra): unique `id` on every label, unique `User.email`, a range index on
`User.age`, and a cosine vector index on `Doc.embedding`. Every contender reads the same nodes.

**Contenders.**

| Contender                 | What runs                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `neo4j-driver` (baseline) | Hand-written Cypher, one session per call, `executeRead` / `executeWrite`, records mapped to plain objects (Integer to number, DateTime to Date) |
| Cyphra                    | The generated typed client, `createClient({ driver })` on the same driver                                                                        |
| neogma                    | neogma 2 models (decorators) on the same labels; neogma always creates its own driver (same version, default config)                             |
| Query API (fetch)         | The baseline's Cypher sent to the Neo4j Query API (`POST /db/neo4j/query/v2`, auto-commit) with `fetch`                                          |
| Cyphra (HTTP)             | The typed client with an `http://` URI (Cyphra's HTTP transport)                                                                                 |
| `@neo4j/graphql` 7.6.8    | `Neo4jGraphQL` on the same driver                                                                                                                |
| `@cyphra/graphql`         | `compat.v7.makeSchema` on the same driver and the same type definitions                                                                          |

All Bolt contenders use `neo4j-driver` 6.3.2 (neogma 2 needs 6.x; Cyphra and `@neo4j/graphql`
accept 5 and 6), the explicit database `neo4j`, and default driver settings. GraphQL documents are
parsed and validated once and cached, then each call is one `execute()`, the way a server with a
document cache runs them.

**Fairness checks.** Before anything is timed, the first answer of every contender is compared
with the baseline's (the email found, the number of rows, comments or posts, the counts, the ids
returned by the vector search), and write scenarios check the database afterwards (the nested
create left 5 posts, the cascading delete left nothing). Every contender walks the same inputs in
the same order. Write scenarios delete what they created after each contender.

**Timing.** [tinybench](https://github.com/tinylibs/tinybench) 6. Each scenario runs 3
interleaved rounds; in each round every contender warms up (10 iterations / 250 ms), then runs at
least 70 iterations and 1 s, one call in flight. The order of the contenders rotates between rounds and
the samples of the 3 rounds are merged, so background noise on the machine is spread over all
contenders instead of landing on one. The report gives
the median and p95 latency, the mean with its 95% margin of error, ops/s (1000 / mean, sequential)
and the overhead of the median against the baseline.

Why tinybench rather than mitata: these are asynchronous, I/O-bound calls of 1 to 100 ms, where
mitata's strengths (sub-microsecond timing, JIT and GC counters for CPU-bound code) do not apply.
tinybench has async tasks with unmeasured `beforeEach` hooks (needed to create the node each
delete removes), exposes the raw samples (for p95 and merging rounds) and is a small dependency.

## Scenarios

| Scenario              | Operation                                                                | neogma | GraphQL |
| --------------------- | ------------------------------------------------------------------------ | ------ | ------- |
| findUnique by id      | One user by unique id                                                    | yes    | yes     |
| findMany              | Users in a 10-year `age` window, ordered by name, first 50               | yes    | yes     |
| Nested read, 2 levels | 10 users with their posts and each post's comments                       | yes    | yes     |
| create                | One user                                                                 | yes    | yes     |
| Nested create         | One user and 5 posts in one transaction                                  | yes    | yes     |
| upsert                | `MERGE` on the unique email (20 keys: create, then update)               | no     | no      |
| update by unique      | Set one field of a user found by id                                      | yes    | yes     |
| delete with cascade   | A user, its 3 posts and their 6 comments (`onDelete: Cascade`)           | no     | yes     |
| Relation count        | 10 users with their number of posts and followers                        | no     | yes     |
| aggregate             | Count, average and max over the 5,000 published posts                    | no     | yes     |
| groupBy               | Posts grouped by `published`, count and average                          | no     | no      |
| 3-hop traversal       | Everyone within 3 `FOLLOWS` hops of a user (about 150 distinct users)    | no     | no      |
| Shortest path         | One shortest `FOLLOWS` path (at most 8 hops) between two connected users | no     | no      |
| Vector findSimilar    | 10 nearest documents to a query vector                                   | no     | no      |

"no" means the library has no API for it (see `na` in [`src/scenarios.ts`](src/scenarios.ts)):
writing raw Cypher through it would only measure the driver again.

## Caveats

- **One machine, loopback.** Neo4j runs in Docker on the same machine as the benchmark: there is
  no network latency, which is the best case for showing the client-side overhead. Over a real
  network (or Aura) every call gains the round-trip time and the relative overhead shrinks.
- **Shared, not isolated.** The machine was not idle (other containers and processes ran during
  the published run); the interleaved rounds spread that noise, they do not remove it. Compare
  contenders within one run, not across runs or machines.
- **No disk.** The database lives on a tmpfs, so commits do not wait for a disk flush. On real
  storage every write gains the flush time (often milliseconds), the same for every contender,
  and the relative overhead of writes gets smaller.
- **Transaction patterns differ.** neogma runs statements in auto-commit transactions
  (`session.run`): one round trip less than the managed transactions (`executeRead` /
  `executeWrite`, which retry transient errors) used by the baseline, Cyphra and the GraphQL
  libraries. That, not less work, is why it can beat the baseline on simple operations.
- **Sequential latency only.** One call in flight. Throughput under concurrency (connection pool
  pressure, server threads) is not measured.
- **Small data set.** 10,000 nodes fit in the page cache; query plans and Neo4j's work are the same
  for every contender, so what is measured is the client side (query building, parameters, result
  mapping) plus the transaction pattern each library uses.
- **The baseline is the best case.** It is one statement per operation, written by hand for this
  data. Real code often adds its own mapping and validation, which this baseline leaves out.
- **Same answers, not always the same Cypher.** Each library sends its own statement; the checks
  above make sure they return the same data, not that Neo4j does the same work.
