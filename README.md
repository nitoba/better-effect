# better-effect

This repository is a Bun + Turborepo monorepo containing the `better-effect`
library, its Fumadocs documentation site, and the official agent skill for
working with the library. The tested runtime matrix is Node.js 24 and Bun
1.3.14.

## Workspaces

- [`packages/better-effect`](./packages/better-effect) — the published TypeScript library
- [`packages/better-effect-better-auth`](./packages/better-effect-better-auth) — the independent server-side Better Auth integration
- [`packages/better-effect-mq`](./packages/better-effect-mq) — the experimental message-queue foundation
- [`packages/better-effect-kysely`](./packages/better-effect-kysely) — the server-side Kysely integration (initial `0.1.0` release preparation)
- [`packages/better-effect-mq-postgres`](./packages/better-effect-mq-postgres) — the optional PostgreSQL JobStore adapter, schema, and migrations for MQ
- [`packages/better-effect-mq-redis`](./packages/better-effect-mq-redis) — the optional Redis/Valkey client, key layout, codecs, and Lua foundation for MQ
- [`apps/docs`](./apps/docs) — the Next.js documentation application powered by Fumadocs
- [`skills/better-effect`](./skills/better-effect) — the official Agent Skill for implementing, reviewing, debugging, and refactoring `better-effect` applications

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

The site is available at <http://localhost:3000>. The Kysely integration guide is
available at <http://localhost:3000/docs/kysely>.

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
It uses random host ports, generated non-root application credentials, and
stops both containers after a passing, failing, or interrupted test run. Ryuk
is disabled only when the discovered Podman engine is rootless. On rootless
Podman, a per-invocation container label provides a scoped `podman rm --force`
fallback if normal cleanup fails. The Testcontainers v12 module API has no
host-address binding option, so it cannot request loopback-only bindings; it
never requests a fixed port.

GitHub Actions enforces this gate in the `MQ MySQL and MongoDB storage
conformance` job using the hosted runner's Docker socket; local development
uses Docker or the discovered Podman socket.

Package releases use qualified tags and publish only the selected package. See
[`docs/release-process.md`](./docs/release-process.md) for the release planner,
initial Better Auth/MQ/Kysely/PostgreSQL release commands, and npm Trusted
Publishing setup.
