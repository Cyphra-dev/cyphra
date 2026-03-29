# Security policy

## Supported versions

We support the latest published minor release line of Cyphra packages on npm.

## Reporting a vulnerability

Please report security issues **privately** via [GitHub Security Advisories](https://github.com/cyphra/cyphra/security/advisories/new) for this repository, or contact the maintainers with a clear subject line.

Include:

- Affected package(s) and version(s)
- Steps to reproduce and impact
- Optional patch or mitigation ideas

We aim to acknowledge reports within a few business days.

## Supply chain

- Lockfile is committed (`pnpm-lock.yaml`); CI runs `pnpm audit` (high severity threshold).
- npm publications use **provenance** when enabled in CI (`NPM_CONFIG_PROVENANCE`).

## Cypher safety

Cyphra’s tagged template and migration APIs bind interpolated values as **Neo4j parameters**. Do not bypass this with raw string concatenation when handling untrusted input.
