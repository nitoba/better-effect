# Version-aware documentation and source lookup

## Evidence and precedence

This refresh was reviewed against
[commit 676c6b9271e8dba7fdf3ca3e8175dfd3a84faf0f](https://github.com/nitoba/better-effect/commit/676c6b9271e8dba7fdf3ca3e8175dfd3a84faf0f)
on 2026-09-09. The core manifest is 0.13.0. This records an audit baseline,
not an npm availability claim or a guarantee about later main commits.

For an application change, use this precedence:

1. Target manifests, lockfile, and actual installed package exports/declarations.
2. Source and executable/type tests for that exact version or commit.
3. Matching package README, examples, and official documentation.
4. This skill's architecture and migration guidance.

Check **each** integration's peer ranges, optional peers, exports, and host
requirements. Sharing the `better-effect-` prefix does not make versions
interchangeable. TypeScript minimums and integration floors come from the
installed manifests; do not silently upgrade the application to match main.
Use only public exports, never convenient `src/` imports in consumer code.
OpenSpec documents and GitHub issues are design evidence, not proof an API ships.

## Published documentation

Canonical discovery endpoints:

- [Human documentation](https://better-effect.nitodev.com.br/docs)
- [LLM page index](https://better-effect.nitodev.com.br/llms.txt)
- [Complete LLM corpus](https://better-effect.nitodev.com.br/llms-full.txt)

Start with the index. Prefer the smallest relevant Markdown page; for a route
`/docs/<path>` the site's representation is
`https://better-effect.nitodev.com.br/llms.mdx/docs/<path>/content.md`.
Follow the current index rather than guessing renamed routes. Use the complete
corpus only for genuine cross-cutting research or when targeted retrieval fails.
Do not load every page into every agent task.

If online docs disagree with the target version, retain the installed contract
or make an explicit upgrade. If a README snippet disagrees with an exported
signature or a type test, use the latter and record the discrepancy. In
particular, verify generator final returns, builder yieldability, callback
argument order, and resource ownership instead of copying a snippet blindly.

## High-value source map

The monorepo's [packages directory](https://github.com/nitoba/better-effect/tree/main/packages)
is the integration inventory. Read the selected package's `package.json`,
`src/index.ts`, README, examples, and relevant tests before changing a boundary.

| Topic | Source entrypoints / evidence |
| --- | --- |
| Generators and lazy Programs | `packages/better-effect/src/effect/effect.ts`, `src/effect/types.ts` |
| Service identity and provider contracts | `packages/better-effect/src/service/`, `src/layer/layer.ts`, `src/layer/types.ts` |
| Execution, tasks, Scope, shutdown | Core `src/runtime/`, `src/effect/task.ts`, `src/scope/`, `src/resource/` |
| Standard services and Config | Core `src/standard-services/index.ts`, `src/standard-services/config.ts` |
| Web/Hono/Next/Bun/Node/tracing/testing | Core package export map and matching `src/` entrypoints |
| Schema providers and capability failures | `packages/better-effect-schema/src/index.ts`, `docs/api.md`, provider guides |
| Outbound HTTP and endpoints/streams | `packages/better-effect-http/README.md`, `examples/endpoints-sdk.ts`, `examples/hono-streaming.ts` |
| HTTP integration guide | [`/docs/http`](/docs/http) |
| Auth hooks and sessions | `packages/better-effect-better-auth/README.md`, `examples/hono/` |
| Native query and transaction contracts | `packages/better-effect-kysely/README.md`, examples and tests |
| Jobs, controls, schedules, flows | `packages/better-effect-mq/src/index.ts`, `src/schedule/README.md`, `tests/types/scheduler.types.ts` |
| Outbox transaction/publisher contract | `packages/better-effect-mq-outbox/README.md` plus the selected adapter README/source |
| Storage compatibility and ownership | PostgreSQL, Redis, MySQL, MongoDB, and SQLite package README/export maps |

Known core subpaths include `adapters/iti`, `bun`, `hono`, `next`, `node`,
`opentelemetry`, `runtime/explicit`, `runtime/node`, `standard-services`,
`testing`, and `web`. They are **subpaths of better-effect**, not additional
standalone packages. Schema providers and Auth/HTTP/SQLite subpaths have their
own optional dependency/host boundaries.

## Keep this skill current

When the package inventory or a public signature changes, update the routing
table in SKILL.md and the matching focused reference together. Update old
transformation examples too, not only the new integration page. Compare source,
examples, and type tests for renamed symbols; distinguish removed APIs from
compatibility aliases and from proposals that never shipped.

Record the reviewed commit/version, run the
[validation scenarios](validation.md), and state exactly which checks ran.
Reading tests is not executing tests, structural documentation checks are not
TypeScript checks, and a source checkout is not a packed-consumer test.
