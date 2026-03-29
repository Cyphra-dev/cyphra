# Cyphra

**Cyphra** is a TypeScript toolkit for [Neo4j](https://neo4j.com/): a `.cyphra` schema DSL, **Cypher-first** querying (tagged templates + a small builder), versioned **migrations**, and a **CLI**.

- **Packages**: `@cyphra/schema`, `@cyphra/query`, `@cyphra/runtime`, `@cyphra/migrator`, `@cyphra/cli`
- **Docs site**: [`doc/`](./doc) (Next.js + Nextra) — `pnpm doc:dev` / `pnpm doc:build`
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

## License

MIT
