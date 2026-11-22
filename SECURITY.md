# Security policy

## Supported versions

We support the latest published minor release line of Cyphra packages on npm.

The support policy for 1.0 and later (including fixes for the previous major) is being drafted in the [stability policy](./STABILITY.md).

## Reporting a vulnerability

Please report security issues **privately** via [GitHub Security Advisories](https://github.com/Cyphra-dev/cyphra/security/advisories/new) for this repository, or contact the maintainers with a clear subject line.

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
