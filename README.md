# better-effect

This repository is a Bun + Turborepo monorepo containing the `better-effect`
library, its Fumadocs documentation site, and the official agent skill for
working with the library. The tested runtime matrix is Node.js 24 and Bun
1.3.14.

## Workspaces

- [`packages/better-effect`](./packages/better-effect) — the published TypeScript library
- [`packages/better-effect-better-auth`](./packages/better-effect-better-auth) — the independent server-side Better Auth integration
- [`packages/better-effect-mq`](./packages/better-effect-mq) — the experimental message-queue foundation
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
