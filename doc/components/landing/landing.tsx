import Link from "next/link";
import type { ReactNode } from "react";
import { highlight, type CodeLang } from "../../lib/highlight";
import { LINKS } from "../links";
import { CopyCommand } from "./copy-command";
import styles from "./landing.module.css";

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
import { createClient } from "./cyphra.gen.js";

const db = createClient({ uri, user, password });

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

const drafts = await db.post.findMany({
  where: {
    published: false,
    author: { is: { email: { endsWith: "@example.com" } } },
  },
  select: { title: true, author: { select: { name: true } } },
});
`;

const CYPHER = `
const rows = await db.$cypher<{ name: string; n: number }>\`
  MATCH (u:User)-[:AUTHORED]->(p:Post) WHERE p.published = \${true}
  RETURN u.name AS name, count(p) AS n ORDER BY n DESC
\`;
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
      region: eu-west-1
      credentialsSecretName: s3-backups
`;

async function Code({
  code,
  lang,
  className,
}: {
  code: string;
  lang: CodeLang;
  className?: string;
}) {
  const html = await highlight(code, lang);
  return (
    <div
      className={`${styles.code} ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function Window({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <figure className={styles.window}>
      <figcaption className={styles.windowBar}>
        <span className={styles.dots} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className={styles.windowTitle}>{title}</span>
        {badge ? <span className={styles.windowBadge}>{badge}</span> : null}
      </figcaption>
      {children}
    </figure>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M3 8h10m-4-4 4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const icon = (d: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {d}
  </svg>
);

const FEATURES: { title: string; body: ReactNode; href: string; icon: ReactNode }[] = [
  {
    title: "A client typed from your schema",
    body: (
      <>
        Models, filters and <code>select</code> / <code>include</code> results are inferred from the
        schema. Rename a field and the compiler finds every call site.
      </>
    ),
    href: "/client",
    icon: icon(
      <>
        <path d="M8 4H6a2 2 0 0 0-2 2v3l-1.5 3L4 15v3a2 2 0 0 0 2 2h2" />
        <path d="M16 4h2a2 2 0 0 1 2 2v3l1.5 3-1.5 3v3a2 2 0 0 1-2 2h-2" />
        <path d="M9.5 12h5" />
      </>,
    ),
  },
  {
    title: "Nested writes, one transaction",
    body: (
      <>
        Create and connect related nodes in a single call. A nested write runs in one transaction:
        all of it lands, or none of it.
      </>
    ),
    href: "/client#writing",
    icon: icon(
      <>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="2.5" />
        <path d="M7.5 8 11 15.8M16.5 8 13 15.8M8.5 6h7" />
      </>,
    ),
  },
  {
    title: "Typed relationship properties",
    body: (
      <>
        Describe an edge with a <code>relationship</code> model and its properties come back typed
        under <code>$edge</code>.
      </>
    ),
    href: "/schema",
    icon: icon(
      <>
        <circle cx="5" cy="12" r="2.5" />
        <circle cx="19" cy="12" r="2.5" />
        <path d="M7.5 12h9" />
        <rect x="9" y="4" width="6" height="4" rx="1" />
        <path d="M12 8v4" />
      </>,
    ),
  },
  {
    title: "Migrations from schema diffs",
    body: (
      <>
        <code>cyphra migrate dev</code> writes a reviewable migration: constraints, indexes,
        backfills for new defaults and guards for required fields.
      </>
    ),
    href: "/migrations",
    icon: icon(
      <>
        <path d="M6 3v12" />
        <circle cx="6" cy="18" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <path d="M18 8.5c0 5-6 4-11 8" />
      </>,
    ),
  },
  {
    title: "Cypher, one call away",
    body: (
      <>
        <code>db.$cypher</code> runs a tagged template and sends every value as a parameter. Cypher
        stays visible; nothing is concatenated into a query.
      </>
    ),
    href: "/client#raw-cypher",
    icon: icon(
      <>
        <path d="m7 8-4 4 4 4M17 8l4 4-4 4" />
        <path d="m14 5-4 14" />
      </>,
    ),
  },
  {
    title: "Start from any database",
    body: (
      <>
        <code>cyphra pull</code> introspects a live Neo4j and writes the schema.{" "}
        <code>cyphra dev</code> starts a local Neo4j 5 in Docker.
      </>
    ),
    href: "/cli",
    icon: icon(
      <>
        <ellipse cx="12" cy="6" rx="7" ry="2.5" />
        <path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" />
        <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
      </>,
    ),
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

/** Background graph for the hero: static SVG, one edge with a CSS pulse (off with reduced motion). */
function HeroGraph() {
  const nodes: [number, number, string?][] = [
    [80, 120],
    [250, 60],
    [210, 250, "mint"],
    [420, 170],
    [60, 360],
    [360, 380, "violet"],
    [560, 300],
    [600, 90],
    [760, 200],
    [700, 420],
    [900, 110],
    [960, 330, "mint"],
    [1120, 220],
    [1100, 440],
    [860, 520],
    [520, 520],
  ];
  const edges: [number, number, boolean?][] = [
    [0, 1],
    [0, 2],
    [1, 2],
    [1, 3],
    [2, 4],
    [2, 5, true],
    [3, 5],
    [3, 6],
    [3, 7],
    [6, 8],
    [7, 8],
    [8, 10],
    [8, 11],
    [6, 9],
    [9, 11, true],
    [10, 12],
    [11, 12],
    [11, 13],
    [9, 14],
    [5, 15],
    [15, 9],
    [13, 14],
  ];
  return (
    <svg
      className={styles.heroGraph}
      viewBox="0 0 1180 580"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="hg-hot" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--cy-mint)" />
          <stop offset="1" stopColor="var(--cy-violet)" />
        </linearGradient>
      </defs>
      {edges.map(([a, b, hot]) => (
        <line
          key={`${a}-${b}`}
          x1={nodes[a][0]}
          y1={nodes[a][1]}
          x2={nodes[b][0]}
          y2={nodes[b][1]}
          className={hot ? styles.edgeHot : styles.edge}
        />
      ))}
      {nodes.map(([x, y, kind]) => (
        <circle
          key={`${x}-${y}`}
          cx={x}
          cy={y}
          r={kind ? 7 : 4.5}
          className={
            kind === "mint" ? styles.nodeMint : kind === "violet" ? styles.nodeViolet : styles.node
          }
        />
      ))}
    </svg>
  );
}

export function Landing() {
  return (
    <div className={`cy-landing ${styles.root}`}>
      {/* Hero */}
      <section className={styles.hero}>
        <HeroGraph />
        <div className={styles.container}>
          <Link href="/migrations" className={styles.announce}>
            <span className={styles.announceTag}>v0.2</span>
            Migrations generated from schema diffs
            <Arrow />
          </Link>
          <h1 className={styles.title}>
            The typed ORM
            <br />
            for <span className={styles.titleAccent}>Neo4j</span>.
          </h1>
          <p className={styles.lede}>
            Describe your graph in a <code>.cyphra</code> schema. Cyphra generates a fully typed
            TypeScript client with nested writes, typed relationships and schema-diff migrations,
            and keeps raw Cypher one call away.
          </p>
          <div className={styles.ctaRow}>
            <Link href="/getting-started" className={styles.btnPrimary}>
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
      </section>

      {/* Showcase */}
      <section className={styles.section} aria-labelledby="showcase-title">
        <div className={styles.container}>
          <header className={styles.sectionHead}>
            <p className={styles.eyebrow}>Schema in, types out</p>
            <h2 id="showcase-title" className={styles.h2}>
              One schema file. A client that knows your graph.
            </h2>
            <p className={styles.sectionLede}>
              Labels, relationships, constraints and TypeScript types all come from one{" "}
              <code>.cyphra</code> file. Run <code>cyphra generate</code> and the client follows
              every change.
            </p>
          </header>
          <div className={styles.showcase}>
            <Window title="schema.cyphra">
              <Code code={SCHEMA} lang="cyphra" />
            </Window>
            <div className={styles.showcaseLink} aria-hidden="true">
              <span>cyphra generate</span>
              <Arrow />
            </div>
            <Window title="main.ts" badge="typed">
              <Code code={CLIENT} lang="ts" />
            </Window>
          </div>
          <div className={styles.cypherRow}>
            <div>
              <h3 className={styles.h3}>Cypher is never hidden</h3>
              <p className={styles.muted}>
                When a query is easier to say in Cypher, say it in Cypher. Values are always sent as
                parameters, and results come back as plain JavaScript: integers as{" "}
                <code>number</code>, temporals as <code>Date</code>.
              </p>
              <Link href="/client#raw-cypher" className={styles.textLink}>
                Raw Cypher in the client <Arrow />
              </Link>
            </div>
            <Window title="report.ts">
              <Code code={CYPHER} lang="ts" />
            </Window>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className={styles.section} aria-labelledby="features-title">
        <div className={styles.container}>
          <header className={styles.sectionHead}>
            <p className={styles.eyebrow}>What you get</p>
            <h2 id="features-title" className={styles.h2}>
              The ergonomics of a modern ORM, built for graphs.
            </h2>
          </header>
          <div className={styles.grid}>
            {FEATURES.map((f) => (
              <Link key={f.title} href={f.href} className={styles.card}>
                <span className={styles.cardIcon}>{f.icon}</span>
                <h3 className={styles.cardTitle}>{f.title}</h3>
                <p className={styles.cardBody}>{f.body}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section className={styles.section} aria-labelledby="workflow-title">
        <div className={styles.container}>
          <header className={styles.sectionHead}>
            <p className={styles.eyebrow}>Workflow</p>
            <h2 id="workflow-title" className={styles.h2}>
              From an empty folder to a typed graph in three commands.
            </h2>
            <p className={styles.sectionLede}>
              Install the CLI with <code>npm i -D @cyphra/cli</code>, write your schema, then:
            </p>
          </header>
          <ol className={styles.steps}>
            {STEPS.map((s, i) => (
              <li key={s.cmd} className={styles.step}>
                <span className={styles.stepNum}>{String(i + 1).padStart(2, "0")}</span>
                <h3 className={styles.cardTitle}>{s.title}</h3>
                <p className={styles.cardBody}>{s.body}</p>
                <code className={styles.stepCmd}>
                  <span className={styles.prompt} aria-hidden="true">
                    $
                  </span>
                  {s.cmd}
                </code>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Operator */}
      <section className={styles.section} aria-labelledby="operator-title">
        <div className={styles.container}>
          <div className={styles.operator}>
            <div className={styles.operatorCopy}>
              <p className={styles.eyebrow}>Cyphra Operator</p>
              <h2 id="operator-title" className={styles.h2}>
                Run Neo4j on your own Kubernetes.
              </h2>
              <p className={styles.sectionLede}>
                A Kubernetes operator and Helm chart for Neo4j Community. Declare an instance and
                get persistent storage, generated credentials, TLS and scheduled S3 backups. It
                works with any Neo4j client.
              </p>
              <dl className={styles.points}>
                {OPERATOR_POINTS.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <div className={styles.ctaRow}>
                <a href={LINKS.operator} className={styles.btnSecondary}>
                  Operator on GitHub
                  <Arrow />
                </a>
              </div>
              <p className={styles.fineprint}>
                Neo4j Community has no online backup, so a backup briefly stops the instance while
                the dump runs.
              </p>
            </div>
            <Window title="blog.yaml" badge="kubectl apply">
              <Code code={OPERATOR_YAML} lang="yaml" />
              <pre className={styles.kubectl}>
                <span className={styles.prompt}>$</span>
                {"kubectl get neo4jinstances\n"}
                <span className={styles.muted}>
                  {"NAME   PHASE   VERSION   LAST BACKUP   AGE\n"}
                </span>
                {"blog   "}
                <span className={styles.ready}>Ready</span>
                {"   5.26      3h            12d"}
              </pre>
            </Window>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className={styles.final}>
        <div className={styles.container}>
          <h2 className={styles.finalTitle}>Give your graph a schema.</h2>
          <p className={styles.sectionLede}>Install, write a schema, run your first typed query.</p>
          <div className={`${styles.ctaRow} ${styles.ctaCenter}`}>
            <Link href="/getting-started" className={styles.btnPrimary}>
              Read the docs
              <Arrow />
            </Link>
            <CopyCommand command="npm i cyphra" />
          </div>
        </div>
      </section>
    </div>
  );
}
