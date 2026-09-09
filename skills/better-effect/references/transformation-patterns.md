# Transformation patterns

These are contextual recipes, not blind search-and-replace rules. Confirm the
target version first. The complete runnable boundary shapes are in
[SKILL.md](../SKILL.md), [frameworks](frameworks.md), and [MQ](mq.md).

## Eager work to lazy Programs

Move module-scope `Effect.gen(generator)` to `Effect.fn(generator)` and pass the
Program to `runtime.run`. Keep parameters in an ordinary function returning a
Program. Do not merely wrap an already-started Effect in `() => effect`.
Inside an async generator, invoke a nested core Program before awaiting its
Result; integration Operations already have their own yieldable boundary.
Every Effect generator finishes with Result, even when its final statement
otherwise looks like a harmless raw value or an already-unwrapped success.

## Contextual constructor DI to inferred requirements

Move repository/client/auth dependencies used only during operations from
constructor plumbing to `yield* ServiceToken` inside the operation. Preserve
plain domain parameters and real constructor/private-field invariants.
`Layer.make(ServiceToken)` can then supply behavior whose method-level Effect
requirements remain checked. Use `Service.of` for structural test doubles;
do not fake private fields with an unchecked object cast.

Normalize expected external errors once with Result.tryPromise and use
Result.await only for an actual async Result. Do not add tryPromise around an
Operation just because it performs I/O; that produces the wrong boundary and
can hide its dependency or failure channels.

## Resource cleanup: use the right overload

The fragments below assume a declared Database token and its acquisition
functions. A simple release callback has **one** parameter:

```ts
const DatabaseLive = Layer.scoped(
  Database,
  connectDatabase,
  (database) => database.close()
)
```

For contextual acquisition and an outcome-aware callback:

```ts
const DatabaseLive = Layer.scopedGen(
  Database,
  async function* () {
    const config = yield* AppConfig
    return Database.connect(config.databaseUrl)
  },
  (database, outcome) => database.close(outcome)
)
```

`Layer.scoped` also has an explicit lifecycle-object overload when quiesce and
outcome-aware release are needed. Do not pass a two-parameter callback to its
simple overload. `Layer.scopedDisposable` captures a real disposal protocol.
Use Effect.acquireRelease for execution-local resources; Effect.add receives
an already-acquired disposable, not its factory or Promise.

Prefer Resource.acquireUseRelease for one local Result-based transaction that
needs no Runtime hierarchy. Never close the contextual Scope from business code
or register a finalizer on two different owners. Preserve a primary operation
failure when release also fails.

## Composition and request scope

| Before | After |
| --- | --- |
| Merge order used to replace a provider | `Layer.override(AppLive, TestLive)` |
| Broad Layer annotation losing provenance | Inference or `satisfies Layer<Provided, Required>` |
| Missing requirements hidden by a cast | Add the provider or correct the inferred contract; `Layer.complete` at the root |
| Bare Runtime passed through modules | `Runtime.For<typeof AppLive>` for owners; typed `Runtime.Executor<R>` for borrowed callbacks |
| Runtime per request | One owner plus `runtime.runWith(RequestLive, program)` |
| Module-global principal/transaction | Execution-local Service through requestLayer/runWith |
| Detached background Promise | `Effect.forkScoped` for process-local work; MQ for durable work |
| Lifecycle worker started at import time | Layer-owned acquisition, explicit readiness, quiesce/drain/release |

A RequestContext Service is appropriate for genuinely cross-cutting context,
not as a substitute for ordinary userId/itemId arguments. Root providers must
not capture whichever request happened to initialize them first.

## Hono: one instance and one captured request boundary

Create `const app = new Hono()` **inside** the HonoEffect.app factory, install
`yield* http.middleware()`, then build routes with `yield* http.gen/handler`.
Return app directly. Resolve the application token through the existing Runtime
without redeclaring a module-level `const app` from an earlier snippet.

Use `yield* http.guard(...)` for Result-based middleware and native Hono
validators before the generator. Keep `c.req.valid(...)` inference; remove
parallel readJson/query/params helpers. Use requestLayer for sessions and
http.stream for managed bodies. A raw Response body on the buffered path does
not extend scoped resource ownership.

## Ecosystem migrations

- Old better-effect-zod imports become the appropriate better-effect-schema
  root/provider imports. Keep native schemas, Result failures, class identity,
  and explicit encoding; do not substitute manual `~standard` implementations.
- Manual ofetch wrappers become HttpClient/HttpEndpoint Operations. Choose one
  retry owner; distinguish attempt limits, total deadlines, safe body replay,
  streaming reconnect, and domain idempotency.
- Auth flags become endpoint mode methods. Build hooks in Auth acquisition with
  the current executor; preserve native Response/cookie semantics.
- Kysely builders remain native and end with `$call(KyselyEffect.execute)` or
  another explicit terminal. Transactions receive a native transaction;
  yielding Database again does not join it.
- Legacy worker/startup plumbing becomes Worker.service(tag).layer(...).
  Resolve/warm providers before waiting for jobs. Replace only storage Layers
  to change durability, not the application's Job descriptors/handlers.
- Post-commit enqueue becomes Job.prepare, makeOutboxRecord, and
  `transaction(resource, record, callback, options?)`. The publisher runs after
  commit. Do not confuse this with appending after a separate transaction.

## Determinism and review

Replace ambient clock/random/logging/ID sources only where useful with the
standard Services and test implementations. Centralize environment validation
using Config descriptors or a validated provider, with an explicit startup
failure policy. Avoid logging raw source values.

Use lazy Program.all/forEach for bounded collections; use allResults when typed
partial outcomes are desired. Keep defects observable and do not pretend
already-started siblings were cancelled. Finish by running the
[validation scenarios](validation.md) relevant to the changed boundary.
