# better-effect Agent Skill

Official skill for the [better-effect ecosystem](https://github.com/nitoba/better-effect/).
It teaches coding agents to implement, review, debug, and refactor TypeScript
applications using better-effect and better-result, together with the monorepo's
schema, HTTP, authentication, database, and durable-work integrations.

The published Runtime entrypoint supports Node.js and Bun. Explicit context
storage is a sequential strategy, not a general browser/Edge portability layer.
The skill records its reviewed commit and prioritizes the target application's
installed versions, public exports, and type contracts over a moving main branch.

## Install

With the Vercel Labs Agent Skills CLI:

```bash
bunx skills add nitoba/better-effect --skill better-effect
```

Install globally for a specific agent:

```bash
bunx skills add nitoba/better-effect --skill better-effect -g -a codex
```

Or use it without a permanent installation:

```bash
bunx skills use nitoba/better-effect@better-effect
```

Install/copy the **whole skill directory**, including `references/`, rather than
only SKILL.md. The main file routes agents to focused references; agents should
load only the references relevant to their current task.

## What it covers

| Area | Guidance |
| --- | --- |
| Core | Result failures, eager Effects and lazy Programs, typed Services/Layers, Runtime executors, Scope, tasks, configuration, diagnostics, and tests |
| Hosts | Web, Hono, Next.js, Bun, and Node boundaries; native validation; managed streaming; one owning application Runtime |
| Schema | better-effect-schema with optional Zod, Valibot, and ArkType providers; decode/make/encode and capability failures |
| HTTP | better-effect-http clients/endpoints, status-discriminated responses, interceptors, retry/auth policies, NDJSON/SSE, and tracing/testing subpaths |
| Authentication | better-effect-better-auth factories, endpoint modes, hooks, and lazy request-scoped Hono sessions |
| Database | better-effect-kysely native builders and explicit terminals, resource ownership, and native transaction semantics |
| Durable work | better-effect-mq jobs, workers, schedules, Flow, events, controls, and administration |
| Storage and outbox | PostgreSQL, Redis/Valkey, MySQL, MongoDB, and SQLite adapter Layers; migrations; record-first transactions and routed publishers |
| Migration and review | Version-aware refactoring, concrete transformation recipes, lifecycle/failure checks, and agent-evaluation scenarios |

The skill does not reproduce Effect TS or invent a second queue, ORM, or schema
framework. It emphasizes public integration APIs, preserved type inference,
explicit transport encoding, and one owner per resource.

## Files

Start with [SKILL.md](SKILL.md), which contains the package routing table,
shared rules, and a minimal application example.

| Reference | Purpose |
| --- | --- |
| [Core API](references/core-api.md) | Effect/Program, Service/Layer, execution, ownership, standard services, and diagnostics |
| [Frameworks](references/frameworks.md) | Request/host integration and streaming lifetimes |
| [Schema](references/schema.md) | Provider-neutral operations and explicit wire encoding |
| [HTTP client](references/http-client.md) | Typed outbound operations, policies, and streams |
| [Better Auth](references/better-auth.md) | Auth factories, hooks, endpoint modes, and sessions |
| [Kysely](references/kysely.md) | Native queries, transaction boundaries, and ownership |
| [MQ](references/mq.md) | Core durable-work application APIs |
| [MQ storage and outbox](references/mq-storage-outbox.md) | All five storage adapters and transactional publication |
| [Refactoring rules](references/refactoring-rules.md) | Inventory and decision rules for existing applications |
| [Transformation patterns](references/transformation-patterns.md) | Corrected and current migration recipes |
| [Official documentation](references/official-documentation.md) | Version precedence, reviewed source map, and targeted documentation lookup |
| [Validation](references/validation.md) | Structural, type, runtime, consumer, and agent-evaluation checks |

The evaluation rubric describes checks to perform; it does not claim that an
independent agent evaluation or every integration test has already run.

## Official documentation

Use the [documentation](https://better-effect.nitodev.com.br/docs) and
[LLM page index](https://better-effect.nitodev.com.br/llms.txt) to discover the
smallest relevant page. The
[complete corpus](https://better-effect.nitodev.com.br/llms-full.txt) is a
fallback for cross-cutting research, not a default context load.

Installed-version source and declarations win when current documentation is
ahead of the application. Read the validation guide before claiming a skill or
application change is verified, and distinguish structural checks from actual
TypeScript, runtime, and packed-consumer test execution.
