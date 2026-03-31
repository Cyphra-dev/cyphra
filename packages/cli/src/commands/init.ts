import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultSchema = `node Example {
  id String @id @default(cuid())
}
`;

const defaultEnvExample = `# NEO4J_URI=neo4j+s://xxxx.databases.neo4j.io
# NEO4J_USER=neo4j
# NEO4J_PASSWORD=secret
# NEO4J_DATABASE=neo4j
`;

/**
 * Scaffold `cyphra.json`, `schema.cyphra`, `migrations/`, and `.env.example`.
 *
 * @param cwd - Project directory.
 */
export async function runInit(cwd: string): Promise<void> {
  const configPath = path.join(cwd, "cyphra.json");
  let configExists = false;
  try {
    await stat(configPath);
    configExists = true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
  }
  if (configExists) {
    throw new Error(
      `cyphra.json already exists at ${configPath}. Remove it or edit it manually; cyphra init does not overwrite an existing project.`,
    );
  }
  const schemaRef =
    "https://raw.githubusercontent.com/cyphra-dev/cyphra/main/schemas/cyphra-config.schema.json";
  await writeFile(
    configPath,
    JSON.stringify(
      {
        $schema: schemaRef,
        provider: "neo4j",
        schema: "./schema.cyphra",
        migrations: "./migrations",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(path.join(cwd, "schema.cyphra"), defaultSchema, "utf8");
  await mkdir(path.join(cwd, "migrations"), { recursive: true });
  await writeFile(path.join(cwd, "migrations", ".gitkeep"), "", "utf8");
  await writeFile(path.join(cwd, ".env.example"), defaultEnvExample, "utf8");
  console.log("Created cyphra.json, schema.cyphra, migrations/, .env.example");
}
