# better-effect

This repository is a Bun + Turborepo monorepo containing the `better-effect`
library, its Fumadocs documentation site, and the official agent skill for
working with the library. CI uses the latest Bun release as its default runtime
and the current Node.js LTS for interoperability smoke tests.

## Workspaces

- [`packages/better-effect`](./packages/better-effect) — the core `Effect`, `Layer`, `Runtime`, `Scope`, and Web/framework entry points
- [`packages/better-effect-http`](./packages/better-effect-http) — the typed Fetch client, endpoints, retries, NDJSON, SSE, and streaming
- [`packages/better-effect-schema`](./packages/better-effect-schema) — provider-neutral Standard Schema classes and optional provider adapters
- [`packages/better-effect-better-auth`](./packages/better-effect-better-auth) — the independent server-side Better Auth integration
- [`packages/better-effect-kysely`](./packages/better-effect-kysely) — the server-side Kysely integration with explicit ownership
- [`packages/better-effect-mq`](./packages/better-effect-mq) — the storage-neutral durable queue, Flow v2, and Worker foundation
- [`packages/better-effect-mq-outbox`](./packages/better-effect-mq-outbox) — storage-neutral durable outbox contracts and publisher
- [`packages/better-effect-mq-postgres`](./packages/better-effect-mq-postgres) — the PostgreSQL JobStore, Flow, events, schedules, and outbox adapter
- [`packages/better-effect-mq-redis`](./packages/better-effect-mq-redis) — the Redis/Valkey client, JobStore, Flow, events, schedules, and Lua adapter
- [`packages/better-effect-mq-mongodb`](./packages/better-effect-mq-mongodb) — the MongoDB JobStore, Flow, events, schedules, and outbox adapter
- [`packages/better-effect-mq-sqlite`](./packages/better-effect-mq-sqlite) — the embedded SQLite JobStore, Flow, events, schedules, and outbox adapter
- [`packages/better-effect-mq-mysql`](./packages/better-effect-mq-mysql) — the MySQL/InnoDB JobStore, Flow, events, schedules, and outbox adapter
- [`apps/docs`](./apps/docs) — the Next.js documentation application powered by Fumadocs
- [`skills/better-effect`](./skills/better-effect) — the official Agent Skill for implementing, reviewing, debugging, and refactoring `better-effect` applications

All integrations use the Layer-first composition model. Applications build one
composition root and let `NodeRuntime`, `Runtime`, or a host-owned manager own
the lifecycle; integrations capture only the non-owning capabilities they need.
See the [package guide](https://better-effect.nitodev.com.br/docs/packages)
for the complete catalog and the [Layer-first migration guide](https://better-effect.nitodev.com.br/docs/migration)
for replacements for removed Runtime-first APIs.

## Agent Skill

Install the official skill with the Vercel Labs Agent Skills CLI:

```bash
bunx skills add nitoba/better-effect --skill better-effect
```

The skill combines architecture/refactoring guidance with the live documentation
published at <https://better-effect.nitodev.com.br/docs>, including its
LLM-friendly `llms.txt`, per-page Markdown content, and `llms-full.txt` fallback.

## Getting started

Install all workspace dependencies from the repository root:

```bash
bun install --frozen-lockfile
```

Run the documentation site in development mode:

```bash
bun run docs:dev
```

The site is available at <http://localhost:3000>. The package catalog, migration
guide, HTTP client, schema, Kysely, Better Auth, and MQ guides are available
under `/docs`.

## Monorepo commands

```bash
bun run build
bun run typecheck
bun run test
bun run lint
bun run format:check
bun run check
```

Turborepo runs each command only in the workspaces that define it and caches
compatible tasks between runs. The root `bun.lock` is the canonical lockfile
for every workspace.

### MQ real-storage conformance

The default test suite does not require database services. Run the explicit
real-storage gate to start disposable MySQL 8 InnoDB and single-node MongoDB
replica-set containers, migrate them, and execute the complete protocol-v1
`jobStoreContract` for both MQ adapters:

```bash
bun run test:containers
```

The harness preserves an existing `DOCKER_HOST`. Without one, it discovers a
rootless Podman socket through `XDG_RUNTIME_DIR`, the current user, or `podman
info`; otherwise it uses the default Docker runtime (as on GitHub Actions).
It uses random loopback-only host ports, generated non-root application
credentials, and stops both containers after a passing, failing, or interrupted
test run. The harness configures the Docker `HostIp` binding as `127.0.0.1` and
verifies it through runtime inspection for both databases. Ryuk is disabled
only when the discovered Podman engine is rootless. A per-invocation container
label provides a scoped `podman rm --force` (or Docker equivalent) fallback if
normal cleanup fails, including a startup/interrupt race.

GitHub Actions enforces this gate in the `MQ MySQL and MongoDB storage
conformance` job using the hosted runner's Docker socket; local development
uses Docker or the discovered Podman socket. The durable adapters also expose
the additive Flow v2, events, schedules, controls, and outbox extensions
documented in their package READMEs.

Package releases use qualified tags and publish only the selected package. See
[`docs/release-process.md`](./docs/release-process.md) for the complete
allowlisted package matrix, release planner, package bootstrap commands, and
npm Trusted Publishing setup.
