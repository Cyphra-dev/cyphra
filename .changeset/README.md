# Changesets

Run `pnpm changeset` before merging user-facing package changes. The release workflow publishes with npm provenance when Trusted Publishers are configured on npm.

All publishable packages (`cyphra`, `@cyphra/*`) are in one **fixed** group in `config.json`, so they share the same semver on each release.
