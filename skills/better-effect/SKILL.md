---
name: better-effect
description: Implement, review, debug, and refactor TypeScript applications with better-effect and better-result. Use for typed failures, Effect/Program composition, contextual Services, Layer environments, Runtime lifecycle, Scope/resources, standard services, Hono integration, DI adapters, testing, and architecture improvements without overengineering.
---

# better-effect for TypeScript

Use this skill when implementing, reviewing, debugging, or refactoring TypeScript code that uses `better-effect`, `better-result`, or an integration provided by `better-effect` such as Hono, standard services, runtime context adapters, testing helpers, or DI backends.

The goal is not to maximize the number of `better-effect` APIs in an application. The goal is to make dependencies, failures, execution boundaries, and resource ownership explicit while keeping the code idiomatic TypeScript.

`better-effect` is Effect-inspired, but it is deliberately much smaller than Effect. Do not import Effect TS architecture by analogy. In particular, do not invent fibers, a scheduler, a Context hierarchy, an instruction tree, streams, queues, or Effect-style abstractions that `better-effect` does not provide.

## Priorities

Optimize in this order:

1. correctness;
2. readable TypeScript;
3. typed expected failures;
4. explicit dependency requirements;
5. correct ownership and lifetime;
6. simple composition roots;
7. testability;
8. good DX and low boilerplate;
9. observability where it has concrete value;
10. performance based on evidence, not speculative abstraction.

Do not sacrifice readability merely to make code look more functional or more Effect-like.

## Required references

For non-trivial implementation or refactoring, read:

- `references/refactoring-rules.md`
- `references/transformation-patterns.md`
- `references/official-documentation.md`

The local references capture stable usage and refactoring heuristics. The published documentation is the live reference for the current public API and examples.

## Source of truth and version compatibility

Before editing an application:

1. inspect `package.json` and the active lockfile;
2. determine the installed versions of `better-effect`, `better-result`, TypeScript, and optional integrations such as `hono` or `iti`;
3. inspect workspace/path/git dependencies when the application is not using the published package;
4. do not assume the installed API matches the latest documentation;
5. use only APIs available in the version actually installed unless the task explicitly includes an upgrade.

This skill was authored against the `better-effect` 0.9.x line, including `Effect.fn`, `Program.all`, two-channel `Layer<Provided, Required>`, hierarchical `Scope`, `Runtime.runWith`, standard services, and the Hono adapter. Treat that as embedded baseline knowledge, not permission to ignore the project's pinned version.

This repository's release gates test Node.js 24 and Bun 1.3.14. Do not infer support for other runtimes from TypeScript declarations or from an adapter's use of web platform values.

When web access is available and the task depends on library behavior or API details, follow `references/official-documentation.md`: discover the relevant page through `llms.txt`, prefer the page-specific Markdown representation, and use `llms-full.txt` only as a fallback or for genuinely cross-cutting research.

## Mental model

Keep these boundaries distinct:

```text
better-result
  Result<A, E>        success/failure control flow
       │
       ▼
better-effect
  Effect<A, E, R>     Result semantics + declaration-only Service requirements
  Program<A, E, R>    lazy Runtime-boundary computation created by Effect.fn
       │
       ▼
  Service             typed contextual dependency token and yieldable contract
       │
       ▼
  Layer<P, R>         declarative provider recipe / environment composition
       │
       ▼
  Runtime<P>          long-lived executor and root lifetime owner
       │
       ▼
  Scope               hierarchical resource/finalizer ownership
```

Important consequences:

- `Effect<A, E, R>` is a type-level facade over a `better-result` Result, not a runtime Effect object.
- `R` is a union of tagged Service instance requirements and is erased at runtime.
- `Effect.gen` is eager: it runs when called.
- `Effect.fn` is the preferred Runtime boundary because it returns a nominal lazy `Program`.
- `Layer` describes acquisition; creating a Layer does not eagerly construct its providers.
- `Runtime` owns a root Scope and creates a child Scope per execution.
- `better-result` remains the single source of truth for expected failures and short-circuiting.

## Task modes

Adapt depth to the request without losing the library's semantics:

- **New implementation:** model failures, Service boundaries, Programs, Layers, Runtime ownership, and resource lifetimes before wiring framework code.
- **Refactoring:** inventory all relevant occurrences first, then fix the pattern consistently rather than updating one example and leaving parallel code behind.
- **Debugging:** trace `Program/Effect -> Runtime -> Result` and `Runtime -> execution Scope -> root Scope`; distinguish expected Result errors, thrown defects, missing dependencies, and cleanup failures.
- **Code review:** compare code with the installed package version, source/tests when available, and the official docs. Separate confirmed correctness gaps from risks that only require CI or integration verification.
- **Architecture/DX:** prefer simplifications that make requirements and ownership visible. Do not add empty layers, generic repositories, or abstract factories merely because the library supports composition.

## Mandatory workflow

### 1. Understand the application before editing

Inspect, when present:

- `package.json` and lockfile;
- TypeScript config and runtime target;
- application entry points and shutdown hooks;
- domain errors and `better-result` usage;
- Services and their tags;
- Layer composition roots and overrides;
- Runtime creation/disposal;
- Scope/resource usage;
- HTTP/framework integrations;
- standard services and configuration;
- DI/container adapters;
- tests, especially type-contract tests;
- relevant scripts for typecheck, lint, test, build, and package validation.

Do not perform mechanical replacements before understanding the actual execution and ownership model.

### 2. Map the work before changing it

In implementation work, identify the boundaries and responsibilities that must exist. In refactoring/debugging, inventory all occurrences of patterns such as:

- expected domain failures thrown as exceptions;
- rejected Promises entering Result workflows without normalization;
- manual `try/catch` that only translates infrastructure exceptions;
- `Result<Result<...>>` or redundant Result/Effect wrapping;
- `Effect.gen` created outside the resolver/Scope context and later passed around as if it were lazy;
- dependencies transported through constructors only because a method needs them at execution time;
- global containers or service locators used from business code;
- manual dependency lists that can drift from implementation;
- `ServiceRuntime.resolve` used in ordinary domain/application code instead of `yield* Service`;
- Runtime creation per request/action without a real isolation requirement;
- unparameterized `Runtime` annotations that accidentally erase environment checks;
- `Layer.merge` relied on for replacement by order;
- duplicate or unstable Service tags;
- root resources acquired per execution or request resources placed in the Runtime root;
- manual `try/finally` lifecycle code that should be Scope-owned;
- `Effect.add` used for acquisition instead of registration of an already-acquired disposable;
- request/tenant context threaded manually through many Service calls;
- custom abstractions duplicating `Layer.override`, `Runtime.runWith`, `Effect.acquireRelease`, `Program.all`, or Result combinators;
- Hono handlers that bypass the request Runtime boundary;
- test suites mutating a global container or relying on serial execution.

Use `references/refactoring-rules.md` for the complete inventory and decision rules.

### 3. Choose the correct boundary

Use this as the default decision table:

| Need | Prefer |
| --- | --- |
| value that can succeed or fail with an expected typed error | `Result<A, E>` |
| Promise that may reject at an infrastructure boundary | normalize with `Result.tryPromise` / relevant `better-result` helper |
| multi-step Result workflow with Service access inside an active Runtime/Scope | `Effect.gen` |
| workflow that must begin only when a Runtime executes it | `Effect.fn` / `Program` |
| contextual application capability | `Service<Self>()('Tag')` |
| provider recipe or application environment | `Layer` |
| long-lived process/server execution owner | long-lived `Runtime` |
| one command/script execution | `Runtime.run` or `Runtime.use` |
| per-execution provider/context | `runtime.runWith` or integration-specific request Layer |
| application/root resource shared across executions | `Layer.scoped` / `Layer.scopedGen` |
| resource owned by one Runtime execution | `Effect.acquireRelease` |
| already-acquired disposable owned by current execution | `Effect.add` |
| manually-owned hierarchy outside Runtime | `Scope.make` / `Scope.run` |
| one local acquire/use/release transaction | `Resource.acquireUseRelease` when its simpler compatibility facade is the better fit |
| short linear Result transformation | `pipe` + Effect combinators |
| lazy collection of Programs with bounded parallelism | `Program.all` |

Plain functions and plain Promises remain valid. Do not convert pure calculations or simple async code to Effects when requirements, Result composition, Runtime boundaries, or ownership gain nothing.

### 4. Implement completely

Complete the relevant flow end-to-end. When refactoring a repeated pattern, update all relevant occurrences rather than leaving a mixed architecture without a reason.

Preserve public behavior, domain contracts, and framework semantics unless the change explicitly requires a behavior change. Document deliberate changes such as moving a provider from Runtime-root lifetime to request lifetime or replacing an accidental global dependency with an execution-local Service.

### 5. Validate

Use the project's own toolchain and scripts. For this repository the canonical full validation is `bun run check`, but consumer applications may use different package managers and commands.

At minimum, run the available equivalents of:

- typecheck;
- tests affected by the change;
- lint;
- non-mutating format check (`bun run format:check` in this repository);
- build when public exports, framework integrations, or package boundaries changed.

Use a write-format command only when intentionally applying formatting. The
repository's `check`, CI and publish gates must not rewrite tracked files.

When type inference is part of the behavior, add or run compile-time type tests rather than relying only on runtime tests.

Do not declare success with regressions introduced by the change.

## `better-result` rules

`better-effect` does not replace `better-result`.

- Model expected failures explicitly.
- Prefer tagged/discriminated error types for domain failure unions.
- Normalize throwing/rejecting infrastructure operations at the boundary with `better-result` helpers such as `Result.tryPromise`.
- Use `Result.await` when yielding a Promise of a Result inside `Effect.gen`/`Effect.fn`.
- Every `Result.gen`/`Effect.gen` generator must finish by returning a `Result`.
- Return `Result.err(...)` for expected business decisions instead of throwing.
- Do not recreate Either/Result, generator short-circuiting, or `UnhandledException` handling locally.
- Keep cleanup failures secondary to an existing program/use failure.
- Runtime boundary classification inspects only nominal `better-result` values; an ordinary domain object with a `status` field remains a successful value.

Do not write:

```ts
return value
```

at the end of an Effect generator when the contract requires:

```ts
return Result.ok(value)
```

## Effect and Program rules

### Prefer `Effect.fn` at Runtime boundaries

`Effect.gen` starts immediately. If execution must wait until `runtime.run`, create a Program:

```ts
const loadUser = (id: string) =>
  Effect.fn(async function* () {
    const users = yield* UserRepository
    const user = yield* Result.await(users.findById(id))

    return Result.ok(user)
  })

const result = await runtime.run(loadUser(userId))
```

Use eager `Effect.gen` when the resolver and Scope are already active, for example inside a Service method invoked by an active Program.

### Use generator style when it improves control flow

Generators are a strong fit for:

- several intermediate Result values;
- multiple Services;
- conditional domain failures;
- resource acquisition;
- mixed sync/async Result operations.

Use `pipe`, `Effect.map`, `mapError`, `andThen`, `andThenAsync`, `tap`, `tapError`, `tapBoth`, `recover`, `recoverAsync`, `flatten`, `as`, `asVoid`, `match`, `all`, and `zip` for shorter linear composition when that is clearer.

Do not build a second Effect pipe abstraction or prototype API. `pipe` is intentionally generic.

### Distinguish `Effect.all` from `Program.all`

`Effect.all` combines already-created Effects. `Program.all` preserves laziness and can limit concurrency:

```ts
const program = Program.all([loadUser(id), loadPermissions(id)], {
  concurrency: 2
})

const result = await runtime.run(program)
```

If a child returns an error or throws, scheduling stops, already-started child
Programs are allowed to settle, and a deterministic primary failure is
retained. There is no cancellation or Fiber scheduler. Use `Program.all`
when starting work during collection construction would violate the desired
Runtime/Scope boundary.

## Service rules

Declare Services with an explicit self type and stable non-empty literal tag:

```ts
class UserRepository extends Service<UserRepository>()('UserRepository') {
  findById(id: string) {
    // ...
  }
}
```

For shared package contracts, prefer a namespaced tag such as `@acme/Logger`.

### Request Services where they are used

Normal application code should prefer:

```ts
const repository = yield* UserRepository
```

This resolves through the active Runtime and contributes `UserRepository` to the Effect requirement channel.

Do not maintain a second manual `requires` array and do not yield string keys.

### Use `Service.of` for structural implementations

When prototype behavior/private fields are not needed:

```ts
const fake = UserRepository.of({
  findById: async (id) => Result.ok({ id })
})
```

Use a real instance when constructor invariants, private state, or prototype behavior matter.

### Let Service methods expose their own requirements

A Service method may return an Effect that yields other Services. `Service.Requirements<T>` and Layer inference can carry those method-level requirements into provider completeness checks. Prefer this over injecting every transitive dependency into constructors purely for bookkeeping.

### Restrict direct `ServiceRuntime` access

`ServiceRuntime` is a container-agnostic integration bridge. It is appropriate in adapters and host integration code. Ordinary application behavior should use `yield* Service` so requirements remain visible to the type system.

## Layer rules

Layers are recipes, not instances.

- `Layer.make(Service)` for zero-argument construction.
- `Layer.make(Service, acquire)` for lazy custom/asynchronous acquisition without Layer-owned cleanup.
- `Layer.succeed(Service, value)` for an already-created value.
- `Layer.scoped(...)` for a Runtime-root provider with cleanup.
- `Layer.gen(...)` when provider acquisition requires other Services.
- `Layer.scopedGen(...)` when contextual acquisition also needs root cleanup/outcome.
- `Layer.merge(...)` for distinct providers.
- `Layer.override(base, ...replacements)` for intentional replacement.
- `Layer.complete(...)` when you want the composition root to assert no external requirements remain.

### Never use merge order as override semantics

`Layer.merge` rejects duplicate tags intentionally. Replacement must be visible:

```ts
const AppTest = Layer.override(
  AppLive,
  Layer.succeed(Database, fakeDatabase)
)
```

Same-tag overrides must have bidirectionally compatible contracts.

### Preserve inference at composition roots

`Layer<Provided, Required>` has two public channels. `Required` means dependencies still external after composition.

Prefer inference or `satisfies` when naming a root:

```ts
const AppLive = Layer.merge(DatabaseLive, RepositoryLive) satisfies Layer<
  Database | UserRepository,
  never
>
```

A normal `:` annotation is safe but can erase provider provenance and make later overrides conservatively retain requirements. Avoid unnecessary explicit annotations.

Treat `Layer.Any` as an explicit unchecked escape hatch, not a default convenience.

## Runtime rules

### Prefer one long-lived Runtime per process/application boundary

Node.js/Bun servers and long-lived applications should normally create one Runtime from the application Layer and dispose it during shutdown:

```ts
await using runtime = await Runtime.make(AppLive)
```

Do not create a Runtime per HTTP request or per button/action unless the whole environment truly belongs to that one execution.

### Choose the appropriate execution form

- `runtime.run(program)` for normal execution against the shared root environment.
- `runtime.runWith(layer, program)` for per-execution providers or overrides.
- `Runtime.run(layer, program)` for one-shot commands/scripts.
- `Runtime.use(layer, callback)` for callback-scoped ownership.

Use `Runtime.For<typeof AppLive>` when a Runtime type must be named without erasing its provided environment.

### Warmup only when startup validation is desired

Providers are lazy by default. Use `{ warmup: true }` or `runtime.warmup()` when a server must fail before accepting traffic if provider acquisition/configuration is invalid.

### Treat cancellation as cooperative

Runtime cancellation uses `AbortSignal`. Pass execution signals through `runtime.run(..., { signal })` and consume `CurrentAbortSignal` when work can cooperate.

Do not assume `better-effect` provides fibers, forced cancellation, or preemptive termination of arbitrary Promises.

### Choose context storage deliberately

The default Node/Bun storage isolates overlapping asynchronous executions. An
`ExplicitRuntimeContextStorage` instance is for hosts that provide their own
context propagation and supports only one non-overlapping async flow; concurrent
overlap is rejected. Do not share one explicit storage instance across
concurrent Runtime executions.

### Dispose gracefully

Runtime disposal rejects new executions, waits for active work, optionally aborts linked signals after a grace period, closes the root Scope, then disposes the backend. Do not manually dispose root Layer resources in a second owner.

Use observers and `onCleanupFailure` for telemetry without replacing the primary program result.

## Scope and resource ownership

Choose lifetime by owner:

```text
application/process lifetime
  -> Layer.scoped / Layer.scopedGen

one Runtime execution/request
  -> Effect.acquireRelease / Effect.add / contextual Scope

manual local lifetime outside Runtime
  -> Scope.make / Scope.run

single local acquire/use/release Result transaction
  -> Resource.acquireUseRelease
```

### Contextual Scope is non-owning

Inside a Runtime execution:

```ts
const scope = yield* Scope
```

may register finalizers, acquire resources, and fork children, but it must not close the owner-managed execution Scope.

Use `Scope.make()` or `fork()` when the caller owns a closeable Scope.

### Use `Effect.acquireRelease` for acquisition

```ts
const connection = yield* Effect.acquireRelease(
  () => pool.connect(),
  (connection, outcome) => connection.close(outcome)
)
```

Use `Effect.add` only after a disposable object has already been acquired:

```ts
const socket = await connectSocket()
const managed = yield* Effect.add(socket)
```

The object must implement callable `Symbol.asyncDispose` or `Symbol.dispose`.

### Preserve cleanup precedence

The general precedence is:

```text
program/use failure > cleanup/release failure > success
```

Do not hide a useful domain failure with a secondary close error. Surface cleanup diagnostics separately when the boundary supports observers.

## Standard services

The optional `better-effect/standard-services` entrypoint contains ordinary Services and test implementations, including:

- `Clock` / `ClockTest`;
- `Random` / `RandomSeeded`;
- `Logger` / `LoggerTest`;
- `CurrentRequest`;
- `CurrentAbortSignal`;
- `Config` and environment/configuration helpers.

Importing standard services does not install hidden providers. Compose their Layers explicitly and override them in tests like any other Service.

Prefer deterministic test implementations for time, randomness, and logging rather than mocking globals when the application already uses these Services.

For typed configuration, use Standard Schema-compatible validation through the Config helpers rather than leaking raw `process.env` access throughout application Services.

## Hono integration

Use `better-effect/hono` when a Hono request should be one better-effect execution boundary.

Create the Runtime once at application startup, then create `HonoEffect` from that Runtime. Install `http.middleware()` before any middleware/handler that needs Services, the request Scope, or request-local resources.

Prefer:

- `http.gen(...)` for generator workflows defined at the route boundary;
- `http.handler(...)` when the Program lives outside the HTTP layer;
- `http.guard(...)` for Result-based middleware such as authentication;
- `requestLayer` for request-local providers.

The adapter supplies request context and links the request `AbortSignal`. Do not resolve Services into Hono's Context manually merely to pass them around again.

Expected `Result.err` values should go through the configured failure policy. Thrown defects remain defects and continue through Hono error handling. The default failure response is redacted; custom `onFailure` policies must serialize only intentional, safe domain details. The adapter's `Failure` and request-Layer requirement channels are part of the public type boundary.

Use Hono/Standard Schema validation middleware before the Program rather than inventing a second validation contract inside the adapter.

## DI backends and adapters

The default `MapLayerBackend` is usually enough. It is lazy, caches by Service tag, and deduplicates concurrent acquisition.

Use `better-effect/adapters/iti` only when the application needs ITI integration. Container-specific identifiers must remain inside the adapter.

When writing an adapter, preserve the token-to-instance relationship:

```ts
resolve<T extends AnyServiceToken>(token: T): InstanceType<T> | PromiseLike<InstanceType<T>>
```

Do not weaken it to an unrelated generic result type such as `resolve<A>(token): A`.

The backend owns provider translation/caching/container cleanup. It does not own Service semantics, Scope outcome semantics, Layer collision policy, or Layer-scoped release callbacks.

## TypeScript guidance

Use modern TypeScript when it improves correctness and clarity:

- `satisfies` for Layer composition contracts;
- discriminated unions / tagged errors with exhaustive handling;
- `await using` for Runtime ownership where supported;
- `import type` for type-only imports;
- literal Service tags;
- inferred generic channels instead of manually repeating them;
- `unknown` at unsafe external boundaries, narrowed before application use;
- `never` for truly impossible channels when inference produces it naturally.

Do not introduce type-level cleverness in application code simply because the library itself uses advanced phantom/variance/provenance machinery. Let the library carry those types.

## Testing rules

Prefer test Layers over global mocks:

```ts
const DatabaseTest = Layer.succeed(
  Database,
  Database.of({
    findById: async (id) => Result.ok({ id })
  })
)

const AppTest = Layer.override(AppLive, DatabaseTest)
```

Use one-shot `Runtime.run` when the test needs only one execution. Use a managed Runtime when multiple calls or lifecycle behavior are under test.

Do not reset a global resolver between tests. Runtime context is designed to be isolated across concurrent executions.

When the public contract depends on inference, write compile-time tests for exact types, including:

- `yield* Service` resolves exactly the Service instance;
- Service requirements are preserved across Effects/combinators;
- Runtime rejects missing Services;
- Layer merge/override contracts behave correctly;
- disposable APIs reject non-disposable values;
- public declaration-only identity/requirements do not leak runtime metadata.

Test lifecycle behavior explicitly when relevant: Err/throw/reject cleanup, child-first/LIFO Scope order, active execution disposal, request-local cleanup, and root resource shutdown.

## Organization and architecture

Organize code by responsibility and feature, not by the library's primitive names alone.

A reasonable application shape often has:

```text
src/
  features/
    users/
      user-service.ts
      user-repository.ts
      failures.ts
      programs.ts
  infrastructure/
    database/
      database.ts
      database-live.ts
  app-live.ts
  main.ts
```

Services should contain meaningful behavior/contracts. Layers should describe construction/composition. The application entry point should select the Runtime/backend and own shutdown.

Do not create giant `services.ts`, `layers.ts`, `errors.ts`, or `utils.ts` files that mix unrelated domains solely to centralize categories.

Constructor parameters are still valid for structural invariants and ordinary values. Do not ban constructor injection dogmatically. The refactoring question is whether a dependency is a contextual capability needed during execution and should therefore participate in the Effect requirement channel.

## Prohibitions

Do not:

- reimplement Effect TS inside the application;
- add fibers, schedulers, queues, streams, Context graphs, or instruction trees by assumption;
- recreate Result/Either or error propagation already provided by `better-result`;
- turn every Promise into an Effect;
- use `Effect.gen` as a cosmetic wrapper around one async call with no composition value;
- construct eager `Effect.gen` values outside the context where their Services must resolve and then treat them as lazy;
- resolve normal business dependencies through global containers or `ServiceRuntime.resolve` when `yield* Service` is appropriate;
- use string keys instead of Service constructors in application code;
- use class names as Service identity instead of stable literal tags;
- use `Layer.merge` for accidental replacement;
- annotate every Layer explicitly and erase inference without a reason;
- create a Runtime per request/action by default;
- close a Runtime/Scope/resource from more than one owner;
- place request resources in the Runtime root or root resources in per-request Scopes without a lifecycle reason;
- treat cleanup failures as more important than an existing primary program failure;
- hide expected domain failures in thrown exceptions;
- leak Hono Context, ITI identifiers, or container-specific types into domain Services;
- introduce new architecture layers merely to demonstrate better-effect features;
- claim validation succeeded without running the available project checks.

## Completion criteria

A task is complete only when the relevant conditions hold:

- expected failures are typed and normalized at the correct boundaries;
- Effect vs Program laziness is correct;
- Service requirements are visible rather than manually duplicated;
- Layer composition is complete and intentional replacements use override semantics;
- Runtime ownership matches the process/application boundary;
- root vs execution-local resource lifetimes are correct;
- cleanup has one owner and preserves primary failures;
- framework integrations execute inside the intended Runtime/Scope boundary;
- test doubles use explicit test Layers where appropriate;
- type inference is preserved rather than erased accidentally;
- code is simpler to understand than before;
- typecheck/tests/lint/format/build checks relevant to the change pass or pre-existing failures are clearly identified.

## Delivery

When finishing an implementation, refactoring, or review, provide a concise report covering:

1. goal and completed scope;
2. important problems found or implementation performed;
3. `better-result` failure-model improvements;
4. `Effect`/`Program` composition decisions;
5. Service and Layer design decisions;
6. Runtime and Scope/resource ownership decisions;
7. framework/adapter integration decisions when relevant;
8. testability and type-contract improvements;
9. simplifications/boilerplate removed;
10. validation commands and results;
11. remaining pre-existing issues or external verification risks.

Final metric:

> correctness + readability + typed failures + explicit requirements + correct ownership + simple composition + testability + idiomatic TypeScript
