# better-effect

This repository is a Bun + Turborepo monorepo containing the `better-effect`
library and its Fumadocs documentation site.

## Workspaces

- [`packages/better-effect`](./packages/better-effect) — the published TypeScript library
- [`apps/docs`](./apps/docs) — the Next.js documentation application powered by Fumadocs

## Getting started

Install all workspace dependencies from the repository root:

```bash
bun install --frozen-lockfile
```

Run the documentation site in development mode:

```bash
bun run docs:dev
```

The site is available at <http://localhost:3000>.

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
