# Cyphra

**Cyphra** is a TypeScript toolkit for [Neo4j](https://neo4j.com/): a `.cyphra` schema DSL, **Cypher-first** querying (tagged templates + a small builder), versioned **migrations**, and a **CLI**.

- **Install (app code)**: `pnpm add cyphra` — re-exports `@cyphra/schema`, `@cyphra/query`, `@cyphra/runtime`, `@cyphra/migrator`
- **CLI**: `pnpm add -D @cyphra/cli`
- **Docs site**: [`doc/`](./doc) (Next.js + Nextra) — `pnpm doc:dev` / `pnpm doc:build`
- **Example app**: [`examples/basic/`](./examples/basic) — `pnpm build` then `pnpm example:basic`
- **Security**: see [SECURITY.md](./SECURITY.md)

## Monorepo

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm format:check
pnpm doc:build
```

## Example

After `pnpm build` (packages need `dist/`):

```bash
pnpm example:basic
```

See [`examples/basic/README.md`](./examples/basic/README.md).

## License

MIT
