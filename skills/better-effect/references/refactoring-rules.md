# Refactoring rules

Use this reference when modernizing an existing TypeScript codebase toward idiomatic `better-effect`. The objective is not to convert every function to an Effect. Refactor only where typed failures, contextual requirements, composition roots, or lifecycle ownership become clearer.

## 1. Build an inventory before editing

Search the whole affected feature, not only the first file that demonstrates the problem.

### Failure model

Look for:

- domain decisions implemented with `throw`;
- infrastructure Promises that reject directly into application code;
- repeated `try/catch` blocks translating the same external exception;
- generic `Error`/`Exception`-style values where callers need to discriminate cases;
- `Result<Result<A, E1>, E2>` caused by wrapping Result-returning functions unnecessarily;
- conversion back and forth between Result and thrown exceptions;
- code that catches an error only to rethrow it unchanged;
- cleanup exceptions replacing a more useful primary operation failure.

### Effect/Program usage

Look for:

- `Effect.gen` values constructed outside a Runtime and stored for later execution;
- `Effect.gen` used merely to wrap one Promise with no Service/Result/resource composition value;
- raw values returned at the end of `Effect.gen`/`Effect.fn` generators instead of a Result;
- Promise<Result> values awaited directly rather than yielded through `Result.await` in generator control flow;
- duplicated branching that Effect/Result combinators already express clearly;
- eager Effect collections built before the desired Runtime boundary where `Program.all` is the correct lazy abstraction;
- custom `map`, `flatMap`, `tap`, `recover`, `zip`, or pipeline wrappers duplicating public combinators.

### Dependency access

Look for:

- constructor parameters that exist only so one method can access a contextual application capability;
- Services passed through several layers without those layers using them;
- global singleton Services;
- a global DI container imported by repositories/services/use cases;
- `ServiceRuntime.resolve(...)` inside normal business behavior;
- manual `requires`, token arrays, registries, or dependency metadata that duplicates what `yield* Service` can infer;
- string dependency keys used in application code;
- runtime constructor names used as identity instead of `serviceTag`;
- unstable or empty Service tags.

Do not automatically remove constructor parameters. Keep constructor injection for true object invariants, immutable configuration values that define an object's identity, and ordinary collaborators that are intentionally structural rather than contextual.

### Layer composition

Look for:

- provider construction mixed into business logic;
- Layer construction scattered across request handlers;
- `Layer.merge` expected to replace a previous provider based on order;
- duplicate Service tags;
- test code rebuilding an entire application graph just to replace one provider;
- root Layers annotated broadly enough to erase useful inference;
- `Layer.Any` introduced for convenience rather than a deliberate unchecked integration boundary;
- unresolved `Layer.Required` Services hidden by casts;
- provider acquisition that needs Services but uses direct global resolution instead of `Layer.gen`/`Layer.scopedGen`.

### Runtime ownership

Look for:

- one Runtime per HTTP request/action by default;
- multiple unrelated modules each creating their own application Runtime;
- Runtime creation deep inside Services/repositories;
- Runtime disposal omitted on process shutdown;
- two owners both attempting to dispose the same Runtime;
- unparameterized `Runtime` types that accidentally erase environment safety;
- long-lived server startup that should detect provider acquisition failures but never uses warmup;
- manual request-local containers that can be expressed as `runtime.runWith` or the framework integration's request Layer;
- new work accepted while a custom shutdown procedure is already disposing resources.

### Scope and resources

Look for:

- application-wide pools/clients acquired inside each `runtime.run`;
- request transactions/files/streams registered in the root Layer;
- manual `try/finally` for resources that belong to an execution Scope;
- `Effect.add` called with a factory or acquisition Promise instead of an already-acquired disposable;
- plain values passed to `Effect.add`/`Scope.add` without disposal protocols;
- code inside an execution attempting to close its contextual Scope;
- finalizers registered in more than one owner;
- cleanup callbacks that ignore the final outcome even though rollback/commit behavior depends on it;
- Resource facade used for a hierarchy of nested lifetimes where Scope is clearer;
- Scope used for a single local Result transaction where `Resource.acquireUseRelease` is simpler.

### Framework integration

For Hono, look for:

- Runtime creation per route;
- `http.middleware()` registered after middleware that needs better-effect context;
- route code manually resolving Services into Hono Context;
- every Service method wrapped by proxy/middleware logic rather than one request execution boundary;
- typed domain errors handled as defects via `app.onError`;
- thrown defects converted into expected domain errors indiscriminately;
- request context threaded manually through Service methods when a request Layer is appropriate;
- validation duplicated inside the Program after Hono validation already established typed input.

### Testing

Look for:

- global container reset helpers;
- serial-test requirements caused by shared mutable DI state;
- module mocks for Services that could be explicit test Layers;
- test doubles forced through real constructors even though `Service.of` is sufficient;
- no type-contract tests for important Service/Layer/Runtime inference;
- lifecycle tests that verify successful cleanup only, ignoring Err/throw/reject paths;
- random/time-dependent tests even though deterministic standard Services are available.

## 2. Decide whether a dependency is contextual

A contextual Service is usually a capability that an operation needs while executing and that should vary by Runtime/environment/test/request.

Strong candidates include:

- repositories backed by replaceable infrastructure;
- database/client capabilities;
- authorization/authentication services;
- clocks/randomness/logging when deterministic replacement matters;
- request/tenant context;
- application configuration providers;
- external API capabilities.

Keep ordinary parameters for domain data:

```ts
findUser(userId)
```

Do not convert `userId` into a Service merely because it varies per request. Use `runWith`/request Layer only for contextual values whose cross-cutting nature justifies environmental access.

Keep constructors for structural object invariants:

```ts
new Money(amount, currency)
new PasswordPolicy(minLength)
```

The rule is not "no constructor injection". The rule is to avoid transporting contextual infrastructure dependencies through constructors and unrelated layers when the Effect requirement channel expresses them more accurately.

## 3. Preserve better-result as the error model

Do not create a second failure channel around `better-result`.

### Expected domain failure

Prefer:

```ts
return Result.err(new UserNotFound({ id, message: 'User was not found' }))
```

over throwing and catching the same expected condition later.

### External rejection/throw

Normalize once at the boundary:

```ts
return Result.tryPromise({
  try: () => client.send(request),
  catch: (cause) =>
    new RemoteServiceFailure({
      cause,
      message: 'Remote service failed'
    })
})
```

Do not repeatedly catch the normalized failure in every caller.

### Generator control flow

Inside `Effect.fn`/`Effect.gen`:

```ts
const user = yield* Result.await(repository.findById(id))
return Result.ok(user)
```

Do not unwrap Result with `if`/manual early returns when `yield*` already gives the intended short-circuit and the branch needs no custom logic.

## 4. Fix eager/lazy boundary mistakes

`Effect.gen` executes immediately. `Effect.fn` defers generator execution until the Program is invoked.

If code does this outside a Runtime:

```ts
const program = Effect.gen(async function* () {
  const database = yield* Database
  return Result.ok(await database.health())
})

await runtime.run(() => program)
```

refactor to:

```ts
const program = Effect.fn(async function* () {
  const database = yield* Database
  return Result.ok(await database.health())
})

await runtime.run(program)
```

Keep eager `Effect.gen` inside already-active Service methods or Runtime callbacks when immediate execution is intentional.

## 5. Refactor contextual constructor DI carefully

Suppose a Service is written as:

```ts
class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly passwords: PasswordHasher
  ) {}
}
```

If those are contextual capabilities and the object has no structural reason to own them, move access to the operation:

```ts
class AuthService extends Service<AuthService>()('AuthService') {
  login(input: LoginInput) {
    return Effect.gen(async function* () {
      const users = yield* UserRepository
      const passwords = yield* PasswordHasher
      // ...
    })
  }
}
```

Then let the Layer's requirement inference expose the dependencies. Do this across the feature where the same pattern occurs; do not leave half of the Services using contextual requirements and half passing the same infrastructure through constructors without a reason.

Do not move plain domain values or constructor invariants into contextual Services.

## 6. Keep Service identity intentional

Use:

```ts
class Logger extends Service<Logger>()('@acme/Logger') {}
```

when the contract crosses package boundaries.

Avoid deriving identity from:

- constructor `.name`;
- file name;
- mutable configuration;
- random/generated strings.

Two classes with the same tag are claiming the same logical contract. Treat tag collisions as design errors unless they are compatible intentional representations.

## 7. Separate behavior from construction

A healthy boundary is:

```text
Service
  behavior + contract + contextual requirements

Layer
  how the Service is acquired/provided/released

Runtime
  which complete environment runs the application
```

Move database connection setup, SDK client construction, credentials/config wiring, and root cleanup out of business methods and into Layers when those resources belong to the application environment.

Do not turn Layers into business-logic containers. Provider factories should construct capabilities, not perform application workflows.

## 8. Make replacement explicit

Never rely on composition order to override a provider.

Bad intent:

```ts
Layer.merge(AppLive, DatabaseTest)
```

Correct intent:

```ts
Layer.override(AppLive, DatabaseTest)
```

This matters in production too: tenant/environment-specific replacement should be deliberate and contract-compatible.

When a test replaces only one provider, preserve the rest of the production Layer instead of rebuilding the whole graph unless the test needs a deliberately smaller environment.

## 9. Preserve Layer inference

Avoid unnecessary explicit annotations such as:

```ts
const AppLive: Layer<AppServices, never> = Layer.merge(...)
```

when future `Layer.override` precision matters.

Prefer:

```ts
const AppLive = Layer.merge(...) satisfies Layer<AppServices, never>
```

or pure inference plus `Layer.complete` at the final root.

A broad annotation can be safe yet lose provider-level provenance. Do not fix resulting type friction with `as any` or `Layer.Any` before checking whether the annotation caused it.

## 10. Put resources in the correct lifetime

### Runtime-root lifetime

Use Layer-scoped providers for shared resources such as:

- DB pools;
- shared HTTP clients with explicit close;
- process-level caches;
- other process-owned resources with application-lifetime cleanup.

### Execution lifetime

Use `Effect.acquireRelease` for:

- request transactions;
- temporary files;
- request body/stream handles;
- leases/locks;
- short-lived connections intentionally scoped to one execution.

### Existing disposable

Use `Effect.add` after acquisition only.

### Local transaction outside Runtime

Use `Resource.acquireUseRelease` when one private acquire/use/release flow is simpler than exposing Scope hierarchy.

Do not choose lifetime based on where code is easiest to write. Choose it based on who owns the resource.

## 11. Preserve cleanup precedence

When the operation fails and cleanup also fails, the operation failure remains primary. Runtime boundary classification inspects only nominal `better-result` values; an ordinary domain object with a `status` field remains a successful value.

Refactors must not accidentally change:

```text
program/use failure > cleanup/release failure > success
```

Use Runtime cleanup observers or Resource release observers to record secondary failures.

If cleanup needs to know success vs failure, use outcome-aware APIs (`Effect.acquireRelease`, `Layer.scopedGen`, finalizers) rather than recomputing outcome from unrelated flags.

## 12. Keep Runtime ownership at the application boundary

A typical server should have one root Runtime:

```ts
const runtime = await Runtime.make(AppLive)
```

and execute many request/program child Scopes against it.

If a request needs contextual providers, prefer:

```ts
runtime.runWith(RequestLive, program)
```

or the Hono adapter's `requestLayer`.

Create a separate Runtime only when the environment itself is independently owned and must have an independent root lifetime.

Use `Runtime.For<typeof AppLive>` when passing a Runtime across modules and you want environment checks to remain exact.

## 13. Avoid accidental type erasure

Investigate these before accepting them:

- `Runtime` without a type parameter in a public application boundary;
- `Layer.Any`;
- `as any` around missing dependencies;
- `unknown as Service` for normal providers;
- generic resolver APIs whose output type is unrelated to the token.

Some erasure is valid at adapter/internal boundaries. Keep it localized and do not make application code pay for container internals.

## 14. Prefer request-local environments to parameter plumbing when justified

Do not make every request value a Service. But values such as authenticated principal, tenant context, correlation context, or a request-scoped transaction may be appropriate when many independent application Services need them and they belong to the execution environment.

Use `runWith` or integration request Layers so concurrent executions stay isolated.

Avoid mutable global request context.

## 15. Hono refactoring rules

A Hono application should normally:

1. create one Runtime during startup;
2. create one `HonoEffect` boundary from that Runtime;
3. install `http.middleware()` before dependent middleware/routes;
4. define route Programs with `http.gen` or reuse external Programs through `http.handler`;
5. map expected Result errors through one failure policy;
6. keep thrown defects in Hono's defect/error path;
7. use `http.guard` for Result-based middleware;
8. use `requestLayer` for contextual providers;
9. dispose the Runtime during application shutdown.

The default failure response must redact exception messages. A custom failure
policy should expose only safe, intentional domain details, and its `Failure`
and request-Layer requirement types must remain checked at the adapter boundary.

Do not resolve all Services and attach them to `c.set(...)` merely to reconstruct constructor DI in the HTTP layer.

## 16. Standard-service refactoring rules

Use standard services when replacing ambient host behavior makes the application easier to test or reason about.

Good candidates:

- `Date.now()` / timers → `Clock` when time is part of behavior and needs deterministic tests;
- `Math.random()` → `Random` when randomness affects behavior;
- ad hoc console logging → `Logger` when structured replacement/testing is useful;
- raw environment access in many modules → validated `Config` boundaries;
- request signal plumbing → `CurrentAbortSignal` when execution code needs cooperative cancellation.

Do not wrap trivial host APIs just for abstraction purity. Introduce a Service when replacement/contextual access has concrete value.

## 17. Test the contracts the refactor relies on

After refactoring, test more than the happy path.

### Runtime behavior

- expected `Result.err` remains the exact error;
- thrown/rejected defects remain defects;
- missing Service requirements are rejected at type boundaries;
- disposal waits for active work;
- request-local providers do not leak to concurrent executions;
- explicit context storage rejects unsupported concurrent overlap.

### Resource behavior

- release happens after success;
- release happens after Err;
- release happens after throw/reject;
- release failure does not replace an existing primary failure;
- child Scope closes before parent finalizers and finalizers are LIFO.

### Type behavior

Use type tests when the refactor depends on:

- exact Service inference;
- Effect requirement unions;
- Layer completeness;
- compatible/incompatible overrides;
- `Runtime.For` environment preservation;
- disposable constraints.

## 18. Stop when the simpler boundary is better

Do not continue refactoring merely to eliminate every constructor, Promise, or plain function.

A good final codebase can contain all of these together:

- pure functions for calculations;
- plain Promises for straightforward external async APIs;
- Results for typed expected failure;
- Effects for Result composition + environmental requirements;
- Programs for lazy Runtime boundaries;
- Services for contextual capabilities;
- Layers for provider construction;
- Runtime/Scope for lifecycle ownership.

The architecture is successful when each abstraction communicates something useful that the simpler one could not.
