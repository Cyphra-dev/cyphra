import Link from "next/link";
import type { ReactNode } from "react";
import { highlight, type CodeLang } from "../../lib/highlight";
import { LINKS } from "../links";
import { CopyCommand } from "./copy-command";
import { DESKTOP_GRAPH, MOBILE_GRAPH, PropertyGraph } from "./hero-graph";
import styles from "./landing.module.css";

const APP_URL = "https://app.cyphra.dev";

const SCHEMA = `
node User {
  id        String  @id @default(cuid())
  email     String  @unique
  name      String?
  posts     Post[]  @relationship(type: "AUTHORED", direction: OUT)
  following User[]  @relationship(type: "FOLLOWS", direction: OUT)
}

node Post {
  id        String  @id @default(uuid())
  title     String
  published Boolean @default(false)
  author    User?   @relationship(type: "AUTHORED", direction: IN)
}

relationship Follows {
  type "FOLLOWS"
  from User
  to   User
  since DateTime @default(now())
}
`;

const CLIENT = `
// One call, one transaction: a user, their post, an edge.
const alice = await db.user.create({
  data: {
    email: "alice@example.com",
    posts: { create: [{ title: "Graphs are everywhere" }] },
    following: { connect: { email: "bob@example.com" } },
  },
  include: { posts: true, following: true },
});

alice.posts;                    // Post[]
alice.following[0].$edge.since; // Date, from the Follows edge
`;

const CYPHER = `
const rows = await db.$cypher<{ name: string; n: number }>\`
  MATCH (u:User)-[:AUTHORED]->(p:Post)
  WHERE p.published = \${true}
  RETURN u.name AS name, count(p) AS n
\`;
`;

const MIGRATION = `
export default defineMigration({
  name: "20261118174710_add-roles",
  async up({ db }) {
    // Backfill User.role with its default on existing nodes.
    await db.execute("MATCH (n:\`User\`) WHERE n.\`role\` IS NULL SET n.\`role\` = $value", {
      value: "member",
    });
    // Create constraint User_handle_unique.
    await db.execute("CREATE CONSTRAINT User_handle_unique IF NOT EXISTS …");
  },
});
`;

const CLOUD_ENV = `
NEO4J_URI=neo4j+s://<your-database-host>:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=<your-password>
`;

const OPERATOR_YAML = `
apiVersion: cyphra.dev/v1alpha1
kind: Neo4jInstance
metadata:
  name: blog
spec:
  version: "5.26"
  resources:
    limits: { memory: 2Gi }
  storage: { size: 20Gi }
  tls: { secretName: blog-tls }
  backup:
    schedule: "0 3 * * *"
    s3:
      bucket: my-backups
      credentialsSecretName: s3-backups
`;

async function Code({ code, lang }: { code: string; lang: CodeLang }) {
  const html = await highlight(code, lang);
  return <div className={styles.code} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Window({
  title,
  badge,
  children,
  className,
}: {
  title: string;
  badge?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={`${styles.window} ${className ?? ""}`}>
      <figcaption className={styles.windowBar}>
        <span className={styles.windowTitle}>{title}</span>
        {badge ? <span className={styles.windowBadge}>{badge}</span> : null}
      </figcaption>
      {children}
    </figure>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className={styles.arrow}>
      <path
        d="M2.5 8h10.5M9 3.5 13.5 8 9 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className={styles.eyebrow}>
      <span aria-hidden="true">(→</span>
      {children}
    </p>
  );
}

/* ---------- Hero scene: a query in the editor, the graph it matches ---------- */

const T = ({ k, children }: { k: string; children: ReactNode }) => (
  <span className={styles[`t_${k}`]}>{children}</span>
);

/** Editor + live graph in one frame. Both animate on the same CSS cycle (--cycle): the query is
 *  typed with autocomplete, it "runs", the result appears, and the matched path lights up. */
function HeroScene() {
  return (
    <figure
      className={styles.scene}
      aria-label="A typed Cyphra query next to the Neo4j graph it reads"
    >
      <div className={styles.sceneEditor}>
        <div className={styles.editorTabs}>
          <span className={styles.tab}>schema.cyphra</span>
          <span className={`${styles.tab} ${styles.tabActive}`}>main.ts</span>
          <span className={styles.tab}>cyphra.gen.ts</span>
        </div>
        <pre className={styles.editorCode}>
          <code>
            <span className={styles.ln}>
              <T k="kw">import</T> {"{ createClient }"} <T k="kw">from</T>{" "}
              <T k="str">&quot;./cyphra.gen.js&quot;</T>;
            </span>
            <span className={styles.ln}> </span>
            <span className={styles.ln}>
              <T k="kw">const</T> db = <T k="fn">createClient</T>
              {"({ uri, user, password });"}
            </span>
            <span className={styles.ln}> </span>
            <span className={`${styles.ln} ${styles.lnActive}`}>
              <T k="kw">const</T> users = <T k="kw">await</T>{" "}
              <span className={styles.typeA}>db.user.</span>
              <span className={styles.typeB}>
                <T k="fn">findMany</T>({"{"}
              </span>
              <span className={styles.caret} aria-hidden="true" />
              <span className={styles.popover} aria-hidden="true">
                <span className={`${styles.popItem} ${styles.popSel}`}>
                  <i>ƒ</i>findMany<em>(args?) → Promise&lt;User[]&gt;</em>
                </span>
                <span className={styles.popItem}>
                  <i>ƒ</i>findUnique<em>(args) → Promise&lt;User | null&gt;</em>
                </span>
                <span className={styles.popItem}>
                  <i>ƒ</i>findFirst<em>(args?) → Promise&lt;User | null&gt;</em>
                </span>
                <span className={styles.popItem}>
                  <i>ƒ</i>create<em>(args) → Promise&lt;User&gt;</em>
                </span>
              </span>
            </span>
            <span className={`${styles.ln} ${styles.rest}`}>
              {"  include: { "}
              <span className={styles.syncTarget}>posts</span>
              {": "}
              <T k="kw">true</T>
              {" },"}
            </span>
            <span className={`${styles.ln} ${styles.rest}`}>{"});"}</span>
          </code>
        </pre>
        <div className={styles.result} aria-hidden="true">
          <div className={styles.resultHead}>
            <span>users</span>
            <span>3 rows</span>
          </div>
          <pre>
            {"alice  posts: ["}
            <T k="str">p1</T>
            {", "}
            <T k="str">p2</T>
            {"]\nbob    posts: []\ncarol  posts: ["}
            <T k="str">p3</T>
            {"]"}
          </pre>
        </div>
        <figcaption className={styles.editorStatus}>
          <span>
            <i className={styles.statusDot} aria-hidden="true" />
            cyphra.gen.ts up to date
          </span>
          <span>TypeScript · 0 problems</span>
        </figcaption>
      </div>

      <div className={styles.sceneGraph}>
        <div className={styles.graphBar}>
          <span>neo4j://localhost:7687</span>
          <span className={styles.matchChip}>(:User)-[:AUTHORED]-&gt;(:Post)</span>
        </div>
        <div className={styles.graphCanvas}>
          <PropertyGraph data={DESKTOP_GRAPH} className={styles.pgDesktop} />
          <PropertyGraph data={MOBILE_GRAPH} className={styles.pgMobile} />
        </div>
        <div className={styles.graphFoot}>
          <span>
            <i className={styles.legendNode} aria-hidden="true" />
            node
            <i className={styles.legendEdge} aria-hidden="true" />
            relationship
          </span>
          <span className={styles.matchNote}>include.posts → [:AUTHORED]</span>
        </div>
      </div>
    </figure>
  );
}

/* ---------- The schema as a graph of types ---------- */

function SchemaModel() {
  const field = (x: number, y: number, name: string, type: string) => (
    <text x={x} y={y} className={styles.smField}>
      {name} <tspan className={styles.smType}>{type}</tspan>
    </text>
  );
  return (
    <svg
      className={styles.graph}
      viewBox="12 24 496 220"
      role="img"
      aria-label="Schema graph: User AUTHORED Post, and User FOLLOWS User with a since DateTime property"
    >
      {/* AUTHORED: User → Post */}
      <g className={styles.gEdge} style={{ ["--i" as string]: 0 }}>
        <path d="M196 170H322" className={styles.gLine} pathLength={1} />
        <path d="M196 170H322" className={styles.gPacket} pathLength={1} />
        <path d="M315 164.5 322 170 315 175.5" className={styles.smHead} />
        <text x="259" y="162" textAnchor="middle" className={styles.gRel}>
          AUTHORED
        </text>
      </g>
      {/* FOLLOWS: User → User, a typed relationship */}
      <g className={styles.gEdge} style={{ ["--i" as string]: 1 }}>
        <path
          d="M64 112V70a14 14 0 0 1 14-14h72a14 14 0 0 1 14 14v38"
          className={styles.gLine}
          pathLength={1}
        />
        <path
          d="M64 112V70a14 14 0 0 1 14-14h72a14 14 0 0 1 14 14v38"
          className={styles.gPacket}
          pathLength={1}
        />
        <path d="M158.5 101 164 108 169.5 101" className={styles.smHead} />
        <text x="192" y="60" className={styles.gRel}>
          FOLLOWS
        </text>
      </g>
      <g className={styles.gProp}>
        <rect x="44" y="42" width="140" height="28" rx="6" />
        <text x="56" y="60">
          since: <tspan className={styles.gPropType}>DateTime</tspan>
        </text>
      </g>
      {/* Node models */}
      {[
        {
          x: 24,
          label: "User",
          fields: [
            ["id", "String"],
            ["email", "String"],
            ["name", "String?"],
          ],
        },
        {
          x: 326,
          label: "Post",
          fields: [
            ["id", "String"],
            ["title", "String"],
            ["published", "Boolean"],
          ],
        },
      ].map((m) => (
        <g key={m.label} className={styles.smNode}>
          <rect x={m.x} y="112" width="170" height="120" rx="12" />
          <path d={`M${m.x} 146H${m.x + 170}`} className={styles.smRule} />
          <text x={m.x + 16} y="134" className={styles.smTitle}>
            <tspan className={styles.smColon}>:</tspan>
            {m.label}
          </text>
          {m.fields.map(([n, t], i) => (
            <g key={n}>{field(m.x + 16, 170 + i * 22, n, t)}</g>
          ))}
        </g>
      ))}
    </svg>
  );
}

/* ---------- Content ---------- */

const CLIENT_POINTS: { title: string; body: ReactNode; href: string }[] = [
  {
    title: "Typed from the schema",
    body: (
      <>
        Filters, <code>select</code> and <code>include</code> results are inferred. Rename a field
        and the compiler finds every call site.
      </>
    ),
    href: "/client",
  },
  {
    title: "Nested writes, one transaction",
    body: "Create and connect related nodes in one call. All of it lands, or none of it.",
    href: "/client#writing",
  },
  {
    title: "Typed relationship properties",
    body: (
      <>
        Model an edge with <code>relationship</code> and its properties come back typed under{" "}
        <code>$edge</code>.
      </>
    ),
    href: "/schema",
  },
];

const STEPS = [
  {
    cmd: "npx cyphra dev",
    title: "Start Neo4j",
    body: "Runs Neo4j 5 in Docker on localhost and writes your .env.",
  },
  {
    cmd: "npx cyphra migrate dev --name init",
    title: "Migrate",
    body: "Turns schema changes into a migration you review and commit.",
  },
  {
    cmd: "npx cyphra generate",
    title: "Generate",
    body: "Writes cyphra.gen.ts: your typed client, ready to import.",
  },
];

const OPERATOR_POINTS = [
  ["Declarative", "One Neo4jInstance resource: version, memory, storage, exposure."],
  ["Credentials", "A generated password in a <name>-auth Secret, with the connection URI."],
  ["TLS", "Bolt and HTTPS from any kubernetes.io/tls Secret, such as one from cert-manager."],
  ["Backups", "Scheduled and on-demand dumps to any S3-compatible storage, with retention."],
] as const;

export function Landing() {
  return (
    <div className={`cy-landing ${styles.root}`}>
      {/* Hero */}
      <section className={styles.hero}>
        <div className={styles.heroGrid} aria-hidden="true" />
        <div className={styles.container}>
          <div className={styles.heroCopy}>
            <Link href="/migrations" className={styles.announce}>
              <span className={styles.announceTag}>v0.2</span>
              Migrations generated from schema diffs
              <Arrow />
            </Link>
            <h1 className={styles.title}>The typed ORM for Neo4j.</h1>
            <p className={styles.lede}>
              Describe your graph in one <code>.cyphra</code> schema. Query its nodes and
              relationships with a TypeScript client that knows every property.
            </p>
            <div className={styles.ctaRow}>
              <Link
                href="/getting-started"
                className={styles.btnPrimary}
                data-event="cta_click"
                data-event-target="get_started"
                data-event-where="hero"
              >
                Get started
                <Arrow />
              </Link>
              <CopyCommand command="npm i cyphra" />
            </div>
            <ul className={styles.meta}>
              <li>Open source, MIT</li>
              <li>Neo4j 5.6+</li>
              <li>
                <a href={LINKS.github}>Star on GitHub</a>
              </li>
            </ul>
          </div>
          <HeroScene />
        </div>
      </section>

      {/* Pattern band */}
      <div className={styles.band} aria-hidden="true">
        <div className={styles.bandTrack}>
          {[0, 1].map((k) => (
            <span key={k} className={styles.bandRow}>
              <span>(:Schema)</span>
              <b>-[:GENERATES]-&gt;</b>
              <span>(:TypedClient)</span>
              <b>-[:QUERIES]-&gt;</b>
              <span>(:Neo4j)</span>
              <b>-[:MIGRATED_BY]-&gt;</b>
              <span>(:Migration)</span>
              <b>-[:RUNS_ON]-&gt;</b>
              <span>(:Kubernetes)</span>
              <b>-[:HOSTED_BY]-&gt;</b>
              <span>(:CyphraCloud)</span>
              <b>-[:STARTS_FROM]-&gt;</b>
            </span>
          ))}
        </div>
      </div>

      {/* Schema → graph */}
      <section className={styles.section} aria-labelledby="schema-title">
        <div className={styles.container}>
          <header className={`${styles.sectionHead} ${styles.reveal}`}>
            <Eyebrow>Schema</Eyebrow>
            <h2 id="schema-title" className={styles.h2}>
              One file describes the whole graph.
            </h2>
            <p className={styles.sectionLede}>
              Nodes, relationships, their direction and their properties live in{" "}
              <code>schema.cyphra</code>. Constraints, indexes, migrations and TypeScript types all
              come from it.
            </p>
          </header>
          <div className={styles.split}>
            <Window title="schema.cyphra" className={styles.reveal}>
              <Code code={SCHEMA} lang="cyphra" />
            </Window>
            <div className={`${styles.graphPanel} ${styles.reveal}`}>
              <SchemaModel />
              <p className={styles.graphCaption}>
                Your schema is a graph too. <code>Follows</code> is a relationship model, so{" "}
                <code>since</code> is typed on the edge.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Client */}
      <section className={styles.section} aria-labelledby="client-title">
        <div className={styles.container}>
          <div className={styles.splitWide}>
            <div className={styles.reveal}>
              <Eyebrow>Typed client</Eyebrow>
              <h2 id="client-title" className={styles.h2}>
                A client that knows your graph.
              </h2>
              <p className={styles.sectionLede}>
                <code>cyphra generate</code> writes one file, <code>cyphra.gen.ts</code>. Import it
                and every query is checked against your schema.
              </p>
              <ul className={styles.points}>
                {CLIENT_POINTS.map((p) => (
                  <li key={p.title}>
                    <Link href={p.href}>
                      <span className={styles.pointTitle}>
                        {p.title}
                        <Arrow />
                      </span>
                      <span className={styles.pointBody}>{p.body}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <Window title="main.ts" badge="typed" className={styles.reveal}>
              <Code code={CLIENT} lang="ts" />
            </Window>
          </div>
        </div>
      </section>

      {/* DX bento */}
      <section className={styles.section} aria-labelledby="dx-title">
        <div className={styles.container}>
          <header className={`${styles.sectionHead} ${styles.reveal}`}>
            <Eyebrow>Developer experience</Eyebrow>
            <h2 id="dx-title" className={styles.h2}>
              Built for the inner loop.
            </h2>
            <p className={styles.sectionLede}>
              Mistakes show up in your editor, schema changes become reviewable code, and a local
              database is one command away.
            </p>
          </header>
          <div className={styles.bento}>
            <article className={`${styles.tile} ${styles.reveal}`}>
              <div className={styles.tileHead}>
                <h3 className={styles.h3}>Typos fail the build, not production</h3>
                <p className={styles.muted}>Every filter is checked against the schema.</p>
              </div>
              <pre className={styles.tileCode}>
                <code>
                  <T k="kw">await</T> db.user.<T k="fn">findMany</T>({"{\n  where: { "}
                  <span className={styles.squiggle}>emial</span>
                  {": "}
                  <T k="str">&quot;alice@example.com&quot;</T>
                  {" },\n});"}
                </code>
                <span className={styles.diag}>
                  <b>ts(2561)</b> Object literal may only specify known properties, but
                  &apos;emial&apos; does not exist in type &apos;WhereInput&lt;…,
                  &quot;User&quot;&gt;&apos;. Did you mean to write &apos;email&apos;?
                </span>
              </pre>
            </article>

            <article className={`${styles.tile} ${styles.reveal}`}>
              <div className={styles.tileHead}>
                <h3 className={styles.h3}>A local Neo4j in one command</h3>
                <p className={styles.muted}>Docker, a data volume and your .env, ready.</p>
              </div>
              <pre className={styles.term}>
                <code>
                  <span className={styles.prompt}>$</span> npx cyphra dev{"\n"}
                  <span className={styles.dim}>Started cyphra-dev-blog; waiting for Neo4j…</span>
                  {"\n"}
                  <span className={styles.dim}>Wrote .env</span>
                  {"\n"}
                  <span className={styles.ok}>✓</span> Neo4j is ready (browser:
                  http://127.0.0.1:7474).
                </code>
              </pre>
            </article>

            <article className={`${styles.tile} ${styles.tileWide} ${styles.reveal}`}>
              <div className={styles.tileHead}>
                <h3 className={styles.h3}>Migrations you can review</h3>
                <p className={styles.muted}>
                  <code>cyphra migrate dev</code> diffs your schema and writes the steps: backfills,
                  guards, constraints.{" "}
                  <Link href="/migrations" className={styles.inlineLink}>
                    How migrations work
                  </Link>
                </p>
              </div>
              <pre className={styles.term}>
                <code>
                  <span className={styles.prompt}>$</span> npx cyphra migrate dev --name add-roles
                  {"\n"}
                  <span className={styles.ok}>✓</span> Created
                  migrations/20261118174710_add-roles.mjs (2 step(s))
                </code>
              </pre>
              <div className={styles.tileWindow}>
                <Code code={MIGRATION} lang="ts" />
              </div>
            </article>

            <article className={`${styles.tile} ${styles.reveal}`}>
              <div className={styles.tileHead}>
                <h3 className={styles.h3}>Cypher is never hidden</h3>
                <p className={styles.muted}>
                  <code>db.$cypher</code> sends every value as a parameter and returns plain
                  JavaScript.
                </p>
              </div>
              <div className={styles.tileWindow}>
                <Code code={CYPHER} lang="ts" />
              </div>
            </article>

            <article className={`${styles.tile} ${styles.reveal}`}>
              <div className={styles.tileHead}>
                <h3 className={styles.h3}>Start from the database you have</h3>
                <p className={styles.muted}>
                  <code>cyphra pull</code> introspects a live Neo4j and writes the schema for you.
                </p>
              </div>
              <pre className={styles.term}>
                <code>
                  <span className={styles.prompt}>$</span> npx cyphra pull{"\n"}
                  <span className={styles.prompt}>$</span> npx cyphra generate{"\n"}
                  <span className={styles.ok}>✓</span> Wrote cyphra.gen.ts
                </code>
              </pre>
            </article>
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section className={styles.section} aria-labelledby="workflow-title">
        <div className={styles.container}>
          <header className={`${styles.sectionHead} ${styles.reveal}`}>
            <Eyebrow>Quickstart</Eyebrow>
            <h2 id="workflow-title" className={styles.h2}>
              Empty folder to typed graph in three commands.
            </h2>
            <p className={styles.sectionLede}>
              Install <code>cyphra</code> and <code>@cyphra/cli</code>, write a schema, then run:
            </p>
          </header>
          <ol className={styles.steps}>
            {STEPS.map((s, i) => (
              <li key={s.cmd} className={`${styles.step} ${styles.reveal}`}>
                <span className={styles.stepNum}>{String(i + 1).padStart(2, "0")}</span>
                <h3 className={styles.h3}>{s.title}</h3>
                <p className={styles.muted}>{s.body}</p>
                <CopyCommand command={s.cmd} className={styles.stepCmd} />
              </li>
            ))}
          </ol>
          <p className={`${styles.center} ${styles.reveal}`}>
            <Link href="/getting-started" className={styles.textLink}>
              Read the full getting started guide <Arrow />
            </Link>
          </p>
        </div>
      </section>

      {/* Run it anywhere */}
      <section className={styles.section} aria-labelledby="run-title">
        <div className={styles.container}>
          <header className={`${styles.sectionHead} ${styles.reveal}`}>
            <Eyebrow>Hosting</Eyebrow>
            <h2 id="run-title" className={styles.h2}>
              Run Neo4j yourself, or let us run it.
            </h2>
            <p className={styles.sectionLede}>
              Cyphra works with any Neo4j 5.6+ database. When you need one, both options below run
              Neo4j Community on Kubernetes.
            </p>
          </header>
          <div className={styles.hosting}>
            <article className={`${styles.hostCard} ${styles.reveal}`}>
              <div>
                <p className={styles.hostKicker}>Cyphra Operator · open source</p>
                <h3 className={styles.h3Lg}>On your own Kubernetes.</h3>
                <p className={styles.muted}>
                  A Kubernetes operator and Helm chart for Neo4j Community. Declare an instance and
                  get persistent storage, credentials, TLS and scheduled S3 backups.
                </p>
                <dl className={styles.defs}>
                  {OPERATOR_POINTS.map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <Window title="blog.yaml" badge="kubectl apply">
                <Code code={OPERATOR_YAML} lang="yaml" />
              </Window>
              <div className={styles.ctaRow}>
                <a
                  href={LINKS.operator}
                  className={styles.btnSecondary}
                  data-event="cta_click"
                  data-event-target="operator"
                  data-event-where="landing"
                >
                  Operator on GitHub
                  <Arrow />
                </a>
              </div>
            </article>

            <article className={`${styles.hostCard} ${styles.hostCloud} ${styles.reveal}`}>
              <div>
                <p className={styles.hostKicker}>
                  Cyphra Cloud · <span className={styles.signalText}>early access</span>
                </p>
                <h3 className={styles.h3Lg}>Managed, one instance per database.</h3>
                <p className={styles.muted}>
                  A dedicated Neo4j Community instance with its own storage, generated credentials
                  and a TLS endpoint. You get a <code>neo4j+s://</code> URI; we run the server.
                </p>
              </div>
              <ul className={styles.cloudPlans}>
                <li>
                  <span>Free</span>
                  <span>1 GB memory · 2 GB storage</span>
                  <b>$0</b>
                </li>
                <li>
                  <span>Starter</span>
                  <span>2 GB memory · 10 GB storage</span>
                  <b>$29</b>
                </li>
                <li>
                  <span>Pro</span>
                  <span>8 GB memory · 50 GB storage</span>
                  <b>$99</b>
                </li>
                <li>
                  <span>Team</span>
                  <span>16 GB memory · 100 GB storage</span>
                  <b>Custom</b>
                </li>
              </ul>
              <ul className={styles.cloudIncl}>
                <li>TLS endpoint, any Neo4j driver</li>
                <li>Generated credentials</li>
                <li>Daily backups on paid plans</li>
                <li>Storage grows online</li>
              </ul>
              <Window title=".env" badge="from the dashboard">
                <Code code={CLOUD_ENV} lang="bash" />
              </Window>
              <p className={styles.fineprint}>Coming soon to the Vercel Marketplace.</p>
              <div className={styles.ctaRow}>
                <a
                  href={`${APP_URL}/signup`}
                  className={styles.btnPrimary}
                  data-event="cta_click"
                  data-event-target="cloud_signup"
                  data-event-where="landing"
                >
                  Create a free database
                  <Arrow />
                </a>
                <Link href="/pricing" className={styles.btnGhost}>
                  See pricing
                </Link>
              </div>
            </article>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className={styles.final}>
        <div className={`${styles.container} ${styles.reveal}`}>
          <svg className={styles.finalEdge} viewBox="0 0 400 24" aria-hidden="true">
            <circle cx="8" cy="12" r="5" />
            <path d="M13 12H390" />
            <path d="M382 5 391 12 382 19" className={styles.finalHead} />
          </svg>
          <h2 className={styles.finalTitle}>Give your graph a schema.</h2>
          <p className={styles.sectionLede}>Install, write a schema, run your first typed query.</p>
          <div className={`${styles.ctaRow} ${styles.ctaCenter}`}>
            <Link
              href="/getting-started"
              className={styles.btnPrimary}
              data-event="cta_click"
              data-event-target="get_started"
              data-event-where="footer_cta"
            >
              Get started
              <Arrow />
            </Link>
            <CopyCommand command="npm i cyphra" />
          </div>
        </div>
      </section>
    </div>
  );
}
