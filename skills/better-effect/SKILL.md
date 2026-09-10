---
name: better-effect
description: Use when implementing, reviewing, debugging, or migrating TypeScript code with better-effect and better-result, including Services, Layers, Runtime, Scope, Hono, Next.js, Bun, Better Auth, Kysely, Standard Schema, HTTP clients, streaming, SSE, durable jobs, schedules, flows, storage adapters, or transactional outbox integrations.
---

# better-effect

Use the smallest combination of Result, Program, Service, Layer, and Scope that
makes the application's failures, dependencies, and resource ownership explicit.
This is **not Effect TS**: do not translate Effect TS APIs by name.

## Start here

1. Inspect the target's manifests, lockfile, public exports, and relevant tests.
   This skill was reviewed against `main@676c6b9` on 2026-09-09 (core 0.13.0).
   Installed-version source and declarations take precedence; a source checkout
   does not prove that every package/version is published on npm.
2. Read [core contracts](references/core-api.md) when touching generators,
   dependencies, execution, or cleanup. Then load only the matching references
   below, not the whole skill directory.
3. Compose one application environment and one owning Runtime. Add request
   Layers and non-owning executors inside that ownership boundary.
4. Check inferred success, failure, and requirement channels; test failure,
   cancellation, and disposal as well as success. Use the
   [validation scenarios](references/validation.md) for review.

## Choose the integration

| Package or boundary | Read | Application-facing model |
| --- | --- | --- |
| `better-effect` | [Core](references/core-api.md) | Effect/Program, Service, Layer, Runtime, Scope, standard services, testing, tracing |
| Core Web, Hono, Next.js, Bun, Node entrypoints | [Frameworks](references/frameworks.md) | One request execution; host-owned startup/shutdown; explicit managed streaming |
| `better-effect-schema` | [Schema](references/schema.md) | Native Zod/Valibot/ArkType schemas, Result-backed decode/make/encode |
| `better-effect-http` | [HTTP client](references/http-client.md) | HttpClient Layers, typed responses/endpoints, policies, byte/NDJSON/SSE streams |
| `better-effect-better-auth` | [Better Auth](references/better-auth.md) | BetterAuth.make/from, typed endpoint modes, hooks, request-scoped sessions |
| `better-effect-kysely` | [Kysely](references/kysely.md) | Native builders, explicit `$call` terminals, owned/borrowed databases, transactions |
| `better-effect-mq` | [MQ](references/mq.md) | Queue/Job, Worker, schedules, Flow, events, controls, administration |
| `better-effect-mq-outbox` | [Storage and outbox](references/mq-storage-outbox.md) | Job.prepare, record-first native transaction, routed publisher |
| `better-effect-mq-postgres` | [Storage and outbox](references/mq-storage-outbox.md) | PostgreSQL stores, explicit migrations, pool ownership |
| `better-effect-mq-redis` | [Storage and outbox](references/mq-storage-outbox.md) | Redis/Valkey stores, events, Redis-native outbox |
| `better-effect-mq-mysql` | [Storage and outbox](references/mq-storage-outbox.md) | MySQL stores and migrations; not MariaDB |
| `better-effect-mq-mongodb` | [Storage and outbox](references/mq-storage-outbox.md) | Transaction-capable MongoDB, explicit layout migrations |
| `better-effect-mq-sqlite` | [Storage and outbox](references/mq-storage-outbox.md) | Embedded stores with separate Bun/Node bindings |

### better-effect-http integration

`HttpClient` is a Service. Keep HTTP operations lazy and consume them inside the
active Runtime; do not create a nested Runtime in a client, hook, or route. For
managed Hono/Web forwarding, use the scoped `routes.stream` boundary so request
resources remain alive through downstream completion.

For existing applications, use [refactoring rules](references/refactoring-rules.md)
and [transformation patterns](references/transformation-patterns.md).
For signatures, source paths, version conflicts, and live documentation lookup,
use [official documentation](references/official-documentation.md).

## Rules that apply across packages

- Declare tokens with `class X extends Service<X>()('@app/X')`; consume
  contextual capabilities with `yield* X`. Keep domain inputs as parameters.
- `Effect.gen` is eager. `Effect.fn` returns a lazy callable Program. Every
  Effect generator returns a **Result**. Layer acquisition factories instead
  return their provider/configuration value, not `Result.ok(value)`.
- Yield a Result directly; yield `Result.await(promiseOfResult)` for an async
  Result. Yield integration Operations directly. A core Program is callable,
  not automatically iterable: pass it to Runtime/Program combinators or invoke
  it inside the active execution before awaiting its Result.
- Preserve inferred `Effect<A, E, R>` and `Layer<Provided, Required>` types.
  Prefer `Layer.complete`, `satisfies`, and `Runtime.For<typeof AppLive>` over
  casts, bare Runtime annotations, or `Layer.Any` to hide missing providers.
- `Layer.merge` composes; `Layer.override` replaces intentionally. A tag is a
  stable logical identity. `Service.of` type-checks a structural implementation;
  it does not validate runtime input, construct an instance, or install private
  fields/prototypes.
- Use one owner per resource. Do not nest a new Runtime in an auth hook,
  HTTP client, worker, repository, or server factory to bypass requirements.
  Independently owned applications may legitimately have separate Runtimes.
- Keep expected failures in Result. Respect each integration's documented
  exception normalization; do not blanket-catch defects as domain errors or
  claim that the entire ecosystem can never throw.
- Preserve Scope ownership through streaming completion, not merely response
  headers. Cancellation is cooperative. Scoped tasks exist; a Fiber scheduler
  and forceful cancellation of arbitrary Promises do not.
- Standard Schema validates; it does not universally encode or reflect.
  HTTP retry, SSE reconnect, job retry, and business idempotency are different
  policies. Durable delivery is at least once, not exactly once.

## Minimal application boundary

```ts
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { Result } from 'better-result'

class Greeting extends Service<Greeting>()('@example/Greeting') {
  greet(name: string) {
    return `Hello, ${name}`
  }
}

const greet = Effect.fn(function* () {
  const greeting = yield* Greeting
  return Result.ok(greeting.greet('Ada'))
})

const AppLive = Layer.complete(Layer.make(Greeting))
await using runtime = await Runtime.make(AppLive)
const result = await runtime.run(greet)
```

Keep root infrastructure in Layers and business behavior in Programs/Services.
Use package integrations before writing a second wrapper around the same boundary.
