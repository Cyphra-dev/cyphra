import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultSchema = `node Example {
  id String @id @default(cuid())
}
`;

const defaultEnvExample = `# NEO4J_URI=neo4j+s://xxxx.databases.neo4j.io
# NEO4J_USERNAME=neo4j
# NEO4J_PASSWORD=secret
# NEO4J_DATABASE=neo4j
`;

async function writeIfMissing(file: string, content: string): Promise<boolean> {
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Scaffold `cyphra.json`, `schema.cyphra`, `migrations/`, and `.env.example`.
 *
 * @param cwd - Project directory.
 */
export async function runInit(cwd: string): Promise<void> {
  const created: string[] = [];
  const skipped: string[] = [];
  const track = (name: string, ok: boolean) => (ok ? created : skipped).push(name);
  track(
    "cyphra.json",
    await writeIfMissing(
      path.join(cwd, "cyphra.json"),
      JSON.stringify(
        {
          schema: "./schema.cyphra",
          migrations: "./migrations",
          generate: "./cyphra.gen.ts",
        },
        null,
        2,
      ) + "\n",
    ),
  );
  track("schema.cyphra", await writeIfMissing(path.join(cwd, "schema.cyphra"), defaultSchema));
  await mkdir(path.join(cwd, "migrations"), { recursive: true });
  await writeIfMissing(path.join(cwd, "migrations", ".gitkeep"), "");
  track(".env.example", await writeIfMissing(path.join(cwd, ".env.example"), defaultEnvExample));
  if (created.length) console.log(`Created ${created.join(", ")}, migrations/`);
  if (skipped.length) console.log(`Kept existing ${skipped.join(", ")}`);
  console.log("Next: `cyphra dev` (local Neo4j), `cyphra generate`, `cyphra migrate dev`.");
  console.log(
    'Optional: add "seed": "tsx seed.ts" to cyphra.json to load data with `cyphra db seed`.',
  );
}
