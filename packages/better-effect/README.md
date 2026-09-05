# better-effect

**Effect-like dependency safety for better-result.**

Type your errors with `better-result`. Typecheck the rest of your application wiring with `better-effect`.

Use Services directly inside `Effect.fn` Programs (or eager `Effect.gen` workflows), compose implementations into application environments, and let TypeScript catch missing dependencies before your application starts — while keeping Promises, `better-result`, and your DI backend.

```bash
bun add better-effect better-result
```

The published Runtime entrypoint is officially supported on Node.js and Bun.
The repository uses the latest Bun release by default and the current Node.js
LTS for interoperability smoke tests. `bun run check` also deletes
and rebuilds `dist`, packs the result into a temporary consumer, and runs the
full Node/Bun `NodeRuntime` child-process suite.

## TypeScript knows what your application needs

```ts
import { Result } from 'better-result'
import { CurrentAbortSignal, Effect, Layer, Runtime, Service } from 'better-effect'

class Database extends Service<Database>()('Database') {
  findUser(id: string) {
    // ...
  }
}

class UserRepository extends Service<UserRepository>()('UserRepository') {
  findUser(id: string) {
    return Effect.gen(async function* () {
      const database = yield* Database

      return Result.ok(await database.findUser(id))
    })
  }
}

const UserRepositoryLive = Layer.make(UserRepository)

await Runtime.make(UserRepositoryLive)
//                 ^^^^^^^^^^^^^^^^^^
// Type error: Database is required but not provided
```

The explicit self type keeps `yield*` inference exact, while the non-empty
literal is the Service's stable logical identity. Services with identical
methods but different tags are different dependencies; use a namespaced tag
such as `@acme/Database` when identities must be shared across packages.

`UserRepository` used `Database`, so `Database` became part of its environment requirements:

```ts
type FindUser = Awaited<ReturnType<UserRepository['findUser']>>
// Effect<User, never, Database>
```

`Effect<A, E, R>` is a type-only facade over a `better-result` Result, not an Effect TS
instruction tree. Constructors remain the handles used by `yield*`, Layers and resolver backends;
the public requirement `R` is a union of tagged Service instances. No dependency list was written
manually.

Services can also describe a contract without requiring a class instance. Use the
static `of` helper to type-check a structural implementation; it returns the same
object unchanged at runtime:

```ts
class Authorization extends Service<Authorization>()('Authorization') {
  declare readonly authorize: (token: string) => Promise<boolean>
}

const authorization = Authorization.of({
  authorize: async (token) => token.length > 0
})

const AuthorizationLive = Layer.succeed(Authorization, authorization)
```

`Authorization.of(...)` does not call a constructor or make the result an
`instanceof Authorization`. For services with constructors, private fields or
other runtime invariants, use `new Authorization(...)` instead.

Service tokens themselves are always declared through `Service<Self>()(tag)`.
Every instance carries a required, declaration-only `ServiceIdentity<Tag>`; no
identity property exists at runtime. `Service.Contract<Authorization>` projects
the marker-free implementation shape accepted by `Service.of` and all Layer
provider APIs. Those boundaries return or provide the branded Service type
without modifying the implementation object. `Service.of(...)` does not create
an alternate token, so the instance contract stays tied to the constructor used
by Layers and resolver backends.

Provide it and the environment becomes complete:

```ts
const DatabaseLive = Layer.make(Database)

const AppLive = Layer.merge(DatabaseLive, UserRepositoryLive)

const runtime = await Runtime.make(AppLive)
```

Use `Layer.empty` when a composition root intentionally has no providers. It is
stable and has the exact `Layer<never, never>` type:

```ts
const EmptyLive = Layer.empty
const runtime = await Runtime.make(EmptyLive)
await runtime.run(() => 'no Services required')
```

For a port/adapter boundary, `Layer.alias` exposes one compatible implementation
under another Service token without constructing, cloning, or proxying it:

```ts
class SqlUserRepository extends Service<SqlUserRepository>()('SqlUserRepository') {
  findById(id: string): string {
    return `sql:${id}`
  }
}

class UserRepository extends Service<UserRepository>()('UserRepository') {
  declare findById: SqlUserRepository['findById']
}

const UserRepositoryPort = Layer.alias({
  from: SqlUserRepository,
  to: UserRepository
})
const ApplicationLive = Layer.merge(Layer.empty, Layer.make(SqlUserRepository), UserRepositoryPort)
```

The alias lazily resolves `from`, returns the same object under `to`, and checks
that the source satisfies the target's `Service.Contract`. Its source remains an
external Layer requirement until the source provider is composed.

And the contract does not disappear after startup.

A Runtime also knows which Services exist in its environment:

```ts
const inspectDatabase = Effect.fn(async function* () {
  const database = yield* Database

  return Result.ok(database)
})

await runtime.run(inspectDatabase)
```

Integration authors that need to trigger work later can capture the Runtime's
non-owning executor capability from an execution or Layer acquisition:

```ts
const captureExecutor = Effect.fn(async function* () {
  const executor = yield* Runtime.executor<Database>()
  return Result.ok(executor)
})

const executor = (await runtime.run(captureExecutor)).unwrap()
await executor.run(inspectDatabase)
```

`Runtime.Executor<R>` exposes only `run` and `runWith`. It always starts a new
child execution on the same Runtime root, so it does not retain request-local
Services or expose `dispose`, `warmup`, `inspect`, backend or Scope ownership.
Applications normally use `runtime.run`; the contextual executor is mainly for
framework adapters and long-lived components.

Runtime boundaries inspect only nominal `better-result` values: `Result.err`
becomes a failed execution, while a plain object with `status: 'error'` is
still a successful value. Intermediate Results do not close the execution
Scope.

`Effect.gen` remains eager for code that already runs inside a resolver and
Scope. `Effect.fn` captures the generator as a lazy `Program` for Runtime
boundaries; the callback form remains supported for compatibility.

Name a Program without executing it. The name is private diagnostic metadata,
so the value remains an ordinary callable function and can be used with `pipe`:

```ts
const loadUser = pipe(
  Effect.fn(async function* () {
    return Result.ok(await userRepository.load(userId))
  }),
  Program.named('user.load')
)

const result = await runtime.run(loadUser, {
  attributes: { userId, requestId }
})
```

`Program.map`, `mapError`, `andThen`, `tap`, `tapError`, and `recover` preserve
their source name. A later `Program.named` call overrides it. Collection
Programs do not concatenate child names; give `Program.all`, `Program.forEach`,
or `Program.allResults` an optional `{ name }` when the collection itself needs
a diagnostic name.

`Program.all` keeps a collection lazy until the returned Program is run. Pass
`{ concurrency: n }` for a positive bounded FIFO worker pool; values retain
input order. If a Program returns an error or throws, scheduling stops, already-
started Programs are allowed to settle, and the deterministic primary failure remains selected;
there is no cancellation or Fiber scheduler.

Use `Program.forEach` when each item needs a lazy Program factory. The callback
receives the item and its input index, and the returned Program produces a
readonly collection in input order:

```ts
const synchronized = Program.forEach(userIds, (userId, index) => synchronizeUser(userId, index), {
  concurrency: 8
})

const result = await runtime.run(synchronized)
```

Use `Program.allResults` when typed validation errors should be retained rather
than short-circuiting. It returns every exact child `Result` as a successful
collection element; defects still stop new work and reject the outer Program:

```ts
const validations = Program.allResults(
  [validateIdentity, validateAddress, validateDocuments] as const,
  { concurrency: 3 }
)

const results = await runtime.run(validations)
```

Both helpers use the same lazy bounded scheduler as `Program.all`: indexes are
claimed in order, output order is stable, and already-started work is always
allowed to settle.

Use `Effect.*` to transform an already-created Result, and `Program.*` to compose
an `Effect.fn` Program without starting it. `Program.map`, `mapError`, `tap`, and
`tapError` preserve that laziness; `andThen` and `recover` accept an Effect, a
Promise of an Effect, or another Program only after their matching Result branch
is selected. `Program.andThen` unions its source and continuation error and
Service requirement channels. `Program.recover` handles and removes the source
`Err` channel, exposes the recovery error channel, and unions the source and
recovery Service requirements. Taps preserve the original Result object on
success.

`Runtime.make(AppLive)` and `Runtime.run(AppLive, program)` use the built-in
`MapLayerBackend`. Pass `{ backend: new ItiLayerBackend() }` when an external
container is needed; `MemoryLayerBackend` remains its compatibility alias from
`better-effect/testing`.

### Verify custom adapters

`better-effect/testing` provides runner-neutral conformance scenarios for
third-party `LayerBackend` and `RuntimeContextStorage` implementations. Each
scenario has a stable `name` and `run` callback, creates a fresh adapter, and
runs the optional adapter cleanup after every assertion outcome. Backends must
synchronously pass the actual readonly pending acquisition Promise collection to
`disposeAll`'s `onPendingAcquisitions` hook, await the callback, then await the
acquisitions before clearing state. Declare the backend's acquisition-failure
policy explicitly: `MapLayerBackend` retries,
while ITI keeps an asynchronous failure cached until disposal.

Register the scenarios with Bun:

```ts
import { describe, test } from 'bun:test'
import { MapLayerBackend } from 'better-effect'
import { layerBackendContract } from 'better-effect/testing'

describe('My backend', () => {
  for (const scenario of layerBackendContract({
    makeBackend: () => new MapLayerBackend(),
    acquisitionFailure: 'retry'
  })) {
    test(scenario.name, scenario.run)
  }
})
```

The same scenarios work with Vitest without adding a runner dependency to the
published entrypoint:

```ts
import { describe, it } from 'vitest'
import { NodeRuntimeContextStorage } from 'better-effect/runtime/node'
import { runtimeContextStorageContract } from 'better-effect/testing'

describe('My context storage', () => {
  for (const scenario of runtimeContextStorageContract({
    makeStorage: () => new NodeRuntimeContextStorage(),
    concurrency: 'concurrent'
  })) {
    it(scenario.name, scenario.run)
  }
})
```

Use `concurrency: 'sequential'` for a storage that rejects overlapping roots
with `RuntimeContextOverlapError`; pass `makeCompanionStorage` to also verify
that it does not leak frames into a Node or explicit storage. See the adapter
guide for the complete `LayerBackend` contract.

Runtimes are async disposables, so request-scoped code can use:

```ts
await using runtime = await Runtime.make(AppLive)
const result = await runtime.run(program)
```

Or let `Runtime.use` own the lifetime:

```ts
const result = await Runtime.use(AppLive, (runtime) => runtime.run(program))
```

For isolated application tests, use the testing facade over that same Layer and
Runtime. It installs only the controlled Services you pass, records lifecycle
events, and disposes automatically:

```ts
import { ClockTest, LoggerTest, TestRuntime } from 'better-effect/testing'

const logger = new LoggerTest()
const result = await TestRuntime.use(
  AppLive,
  {
    overrides: [DatabaseTest],
    clock: new ClockTest(Date.UTC(2026, 0, 1)),
    logger
  },
  async (test) => {
    const value = await test.run(loadDashboard)
    expect(test.observer.executionEnds).toHaveLength(1)
    return value
  }
)

expect(logger.events).toHaveLength(1)
```

A long-lived test boundary supports integration-style request Layers as well:

```ts
await using test = await TestRuntime.make(AppLive, { overrides: [DatabaseTest] })
const result = await test.runWith(RequestLive, handleRequest)
```

`TestRuntime.use` preserves program-vs-cleanup failure precedence. The default
recorder is available as `test.observer`; use `test.runtime` only when an
advanced test explicitly needs the underlying Runtime.

Layer providers remain lazy unless startup validation is requested. Warm them
all before accepting work with either form:

```ts
const runtime = await Runtime.make(AppLive, { warmup: true })

// or, after creating the Runtime
await runtime.warmup()
```

Warmup failures include the Service and resolution path, release resources
already acquired, dispose the backend and reject the Runtime. Optional
observers expose Service resolution/acquisition, execution and Layer release
events without coupling the core to an observability SDK. Service events carry
an optional matching `executionId` only when they occur inside an active
execution; warmup and Runtime-root activity omit it. Execution events carry one
matching `executionId`, the optional Program name, copied readonly attributes,
and a monotonic `durationMs` measured through execution cleanup. An end event
keeps the primary program `outcome` and adds `cleanupFailure` when execution
Scope cleanup fails:

```ts
const runtime = await Runtime.make(AppLive, {
  observers: [
    {
      onExecutionStart: ({ executionId, name, attributes }) =>
        console.debug('program.start', { executionId, name, attributes }),
      onExecutionEnd: ({ executionId, outcome, durationMs }) =>
        metrics.observe('program.duration_ms', durationMs, {
          executionId,
          outcome: outcome.status
        })
    }
  ]
})
```

The Runtime does not serialize or inspect attribute values. Attributes are
shallow-copied and exposed as a readonly event view; do not attach secrets,
large objects, or mutable application state. Keep sensitive values out of
observer logs and metrics labels.

For coarse, synchronous diagnostics, use `runtime.inspect()`:

```ts
const inspection = runtime.inspect()
// {
//   state: 'active',
//   warmup: 'idle',
//   activeExecutions: 0,
//   executions: [],
//   services: ['Database', 'UserRepository'],
//   shutdownSignalAborted: false
// }
```

The returned snapshot and its arrays are detached and immutable. It contains
only public Service tags and execution IDs, names and start timestamps; it never
resolves Services, warms the Runtime, creates Scopes, invokes observers or
exposes providers, instances, signals, attributes or backend state. Execution
entries remain present until their execution Scope cleanup settles. Warmup is
reported as `idle`, `running`, `completed` or `failed`, and `state` reports
`active`, `disposing` or `disposed`.

`inspect()` is diagnostic information, not a lock, synchronization primitive or
readiness guarantee. It cannot cancel or force shutdown of any execution; use
`dispose()` and cooperative `AbortSignal` handling for lifecycle coordination.

Missing, circular, and provider-construction failures use the logical Service
tags in `ServiceNotFoundError`, `CircularDependencyError`, and
`ServiceAcquisitionError`; the latter preserves the original provider cause.

```ts
const runtime = await Runtime.make(AppLive, {
  observers: [
    {
      onServiceResolve: (event) => console.debug(event.service.serviceTag),
      onExecutionEnd: (event) => console.debug(event.outcome.status)
    }
  ]
})
```

For lifecycle assertions, `better-effect/testing` provides a recorder and a
best-effort composition utility:

```ts
import { RecordedRuntimeObserver, RuntimeObserver } from 'better-effect/testing'

const recorded = RecordedRuntimeObserver.make()
const runtime = await Runtime.make(AppTest, {
  observers: [
    RuntimeObserver.compose(recorded, {
      onExecutionEnd: ({ outcome }) => console.debug(outcome.status)
    })
  ]
})

await runtime.run(program)
const snapshot = recorded.snapshot()
expect(snapshot.executionEnds).toHaveLength(1)
expect(snapshot.timeline).toContain(snapshot.executionEnds[0])

await runtime.dispose()
```

`RecordedRuntimeObserver` preserves event identity in immutable category views
and its ordered `timeline`; call `clear()` to reuse it. Composition invokes
observers in declaration order and isolates thrown or rejected observer
failures from the Runtime result.

### Optional OpenTelemetry tracing

Install the OpenTelemetry API only when this subpath is used:

```bash
bun add better-effect @opentelemetry/api
```

`better-effect/opentelemetry` accepts either an existing `Tracer` or an existing
`TracerProvider`. Its supported `@opentelemetry/api` peer range is
`>=1.9.0 <1.10.0` (tested with 1.9.1). It never installs a global provider, SDK,
context manager or exporter. The provider form only calls `getTracer`:

```ts
import { trace } from '@opentelemetry/api'
import { OpenTelemetryRuntimeObserver } from 'better-effect/opentelemetry'

const observer = OpenTelemetryRuntimeObserver.make({
  // An existing provider can be passed instead with `provider` and `tracerName`.
  tracer: trace.getTracer('acme.application'),
  serviceResolution: 'events',
  recordFailures: true,
  executionAttributeAllowlist: ['requestId'],
  sanitizeFailure: (cause) =>
    cause instanceof KnownDomainError ? { message: cause.code } : undefined
})

const runtime = await Runtime.make(AppLive, { observers: [observer] })
```

The adapter starts one span for each execution, keyed only by the Runtime's
`executionId`. The Program name is the span name, with
`better-effect.execution` as the stable fallback. Executions whose program and
execution cleanup succeed use OpenTelemetry `OK`; typed `Result.err` values,
thrown defects and execution cleanup failures use `ERROR`. The Runtime observer
keeps cleanup failure separate from the primary program outcome, so the adapter
can report the final execution status without turning cleanup into a program
defect or serializing its cause by default.
Span timing is supplied by OpenTelemetry's start/end clock; `durationMs` is not
written as a second duration source.

Service telemetry is explicit and defaults to `off`:

- `off` creates no Service telemetry.
- `events` adds resolution, acquisition and release events to an execution span
  only when the Runtime event carries an explicit active execution ID. Warmup,
  Runtime-root cleanup and other events without an owner use standalone spans.
- `spans` creates child Service spans only for events with an explicit active
  execution ID. Warmup and Runtime-root cleanup are represented by standalone
  service spans (or generic event-carrier spans in `events` mode); ambient
  OpenTelemetry context is never used to guess ownership.

Service identity is always the logical `serviceTag`; constructor names and
Service instances are never used. `RuntimeObserver.compose` can combine this
adapter with recorded, graph and application observers, and a tracer failure is
isolated from every Runtime result. Call `observer.dispose()` when an observer
may outlive its Runtime to end state left by malformed or missing end events;
normal execution spans are ended exactly once by their matching `executionId`.

Telemetry is privacy-preserving by default. The adapter records only bounded
library, execution ID, Program/outcome, Service-tag and resolution-path data.
It does not record causes, stacks, requests, arbitrary execution attributes or
Service instances, and it never stringifies unknown values. Add attributes only
through `executionAttributeAllowlist` or the explicit
`sanitizeExecutionAttributes` callback; add failure details only through
`sanitizeFailure` together with `recordFailures: true`. Unsupported values are
dropped, strings are bounded, and default limits are 256 characters, 32
attributes and 16 resolution-path tags (caller limits remain capped). Sanitizer
callbacks should return only intentional scalar OpenTelemetry attributes.

For distributed tracing, establish the caller's OpenTelemetry context before
calling `runtime.run`; the adapter does not propagate context or instrument
HTTP/database libraries automatically.

For a startup view of the graph actually observed by a Runtime, compose the
small graph observer and warm the Layer before accepting work:

```ts
import { Runtime } from 'better-effect'
import { RuntimeGraphObserver } from 'better-effect/testing'

const graph = RuntimeGraphObserver.make({ rootLabel: 'Runtime' })
const runtime = await Runtime.make(AppLive, {
  warmup: true,
  observers: [graph]
})

console.log(graph.toJSON())
console.log(graph.toMermaid())
await runtime.dispose()
```

`RuntimeGraphObserver` uses only public resolution and acquisition events. Its
snapshot is sorted, detached and immutable; it records Service tags and counts,
not instances, scopes, causes or execution attributes. Providers that are never
resolved remain absent, and `clear()` starts a new diagnostic session.

Cancellation is cooperative and uses `AbortSignal`; no scheduler or fibers are
created. Pass a signal to one execution and read it from the program when an
I/O operation supports cancellation. Runtime disposal waits for active work;
it does not forcibly terminate arbitrary Promises:

```ts
const result = await runtime.run(program, { signal: request.signal })

const cancellableProgram = Effect.fn(async function* () {
  const signal = yield* CurrentAbortSignal
  return Result.ok(await fetchData({ signal }))
})
```

For a Node.js or Bun CLI, use the host-specific `better-effect/node` entrypoint.
`NodeRuntime.runMain` validates its signal and callback options before installing
`SIGINT`/`SIGTERM` listeners, links the first signal to `CurrentAbortSignal`,
and disposes the Runtime exactly once:

```ts
import { NodeRuntime } from 'better-effect/node'

const main = Effect.fn(async function* () {
  const signal = yield* CurrentAbortSignal
  return Result.ok(await runCommand({ signal }))
})

await NodeRuntime.runMain(AppLive, main, {
  onFailure: (error) => {
    console.error(error)
    return 1
  },
  onSuccess: () => 0
})
```

`Result.err` uses `onFailure` (or exit code `1` by default), while thrown defects
remain rejected and may be reported with `onDefect`. Cleanup-only failures use
`onCleanupFailure`, remain observable, and still set a non-zero
`process.exitCode` after successful work. The first `SIGINT` or `SIGTERM`
immediately aborts `CurrentAbortSignal`; Runtime disposal then waits
cooperatively for the main execution. Listeners are removed in `finally`,
repeated signals are ignored, and the helper never calls `process.exit()`.
The Node boundary intentionally does not expose a second grace-period policy;
use `Runtime.dispose` directly when a managed Runtime needs one.

For request-local context or overrides, add a Layer only to that execution:

```ts
const result = await runtime.runWith(RequestLive, handleRequest)
```

The request Layer may use root Services, while its scoped providers are closed
with the execution Scope and never change the shared Runtime environment. Its
external requirements must be provided by the Runtime, and the Hono failure
handler/request-Layer types are checked at the adapter boundary.

### Framework-neutral Web request boundaries

The `better-effect/web` entrypoint provides a small Request-to-Response
boundary without depending on Hono or another framework. Use it anywhere a
framework gives you standard Web `Request` and `Response` values:

```ts
import { Result } from 'better-result'
import { CurrentAbortSignal, Effect } from 'better-effect'
import { CurrentRequest } from 'better-effect/standard-services'
import { WebEffect } from 'better-effect/web'

const handleRequest = (request: Request) =>
  WebEffect.handleWith(
    runtime.executor,
    request,
    Effect.fn(async function* () {
      const currentRequest = yield* CurrentRequest
      const signal = yield* CurrentAbortSignal
      const user = yield* UserService
      const result = yield* Result.await(user.find())

      return Result.ok({
        result,
        url: (currentRequest.request as Request).url,
        aborted: signal.aborted
      })
    })
  )
```

`WebEffect.handleWith` supplies `CurrentRequest`, forwards `request.signal`, and
runs one lazy Program in a child Scope. Request-local resources are released
before the returned Promise resolves; Runtime-root resources remain owned by
the Runtime. A `requestLayer` option can add per-request providers or
intentionally override a compatible request tag.

The default success policy passes through a Web `Response`, maps top-level
`undefined` to 204, and wraps supported values as `{ data: value }` JSON. A
non-`undefined`, non-`Response` value must be an acyclic graph of `null`,
booleans, strings, finite numbers, dense arrays, and plain object records.
Arrays must have only the own string properties `length` and one property for
each index from `0` through `length - 1`; each index must be an enumerable data
property. Symbol keys, extra own properties (including non-enumerable ones),
sparse holes, and accessor elements are rejected. Object records must have
`Object.prototype` or `null` as their prototype, and every own string-keyed
property must be an enumerable data property. Own symbol keys,
non-enumerable properties, accessors, custom prototypes, and other non-plain
objects are rejected. Shared references in separate branches are serialized as
repeated values. Nested `undefined`, `bigint`, functions, symbols, and
non-finite numbers (`NaN` and infinities) are rejected with
`WebEffectSerializationError` (a `TypeError`) instead of being silently dropped
or coerced. Use an explicit `onSuccess` policy for other representations. The
default failure policy passes through a standards-compatible `Response`
failure and redacts every other typed failure to `{ error: 'Internal Server Error' }`
with status 500. Custom
`onSuccess`/`onFailure` policies may be asynchronous but must return a
standards-compatible `Response`. The boundary checks that protocol structurally:
`status` is an integer in `0` or `200` through `599`, `ok` matches the 2xx
status range, `redirected` and `bodyUsed` are booleans, `statusText` and `url`
are strings, `type` is a standard Response type, and
`arrayBuffer()`, `blob()`, `bytes()`, `clone()`, `formData()`, `json()`, and
`text()` are callable. `headers` must provide callable `append()`, `delete()`,
`get()`, `getSetCookie()`, `has()`, `set()`, and `forEach()` operations. `body`
must be `null` (including legitimate null-body Responses such as `204`) or a
ReadableStream-compatible object with a boolean `locked` property and callable
`cancel()`, `getReader()`, `pipeThrough()`, `pipeTo()`, and `tee()` methods.
Native cross-realm Responses and other values satisfying this protocol are
accepted without `instanceof Response`; missing capabilities and forged
`Response.prototype` values fail with `TypeError`. Thrown defects remain
rejected. The Program's Service and failure channels, request-Layer
requirements, and override compatibility are checked at the TypeScript
boundary.

### Next.js App Router request boundaries

The optional `better-effect/next` entrypoint adapts an application-owned
Runtime to native Next.js App Router Route Handlers without importing Next.js
from the core or main entrypoint:

```ts
import { Result } from 'better-result'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { NextEffect } from 'better-effect/next'

class UserService extends Service<UserService>()('UserService') {
  find(id: string) {
    return { id, name: 'Ada' }
  }
}

const runtime = await Runtime.make(Layer.make(UserService))
const http = NextEffect.make(runtime)

export const GET = http.gen(async function* (_request, context: RouteContext<'/api/users/[id]'>) {
  const { id } = await context.params
  const users = yield* UserService

  return Result.ok(users.find(id))
})
```

`NextEffect.gen` and `NextEffect.handler` return the native
`(request, context) => Promise<Response>` shape expected by App Router route
files. The context is typed with Next's asynchronous `params`; `handler` is
useful when the complete `Effect.fn` Program already exists.

For a long-lived App Router application, keep the Runtime in an
application-owned module and expose explicit disposal for the host lifecycle:

```ts
// app/runtime.ts
export const appRuntime = await Runtime.make(AppLive)

// Call this from the actual host/server shutdown hook.
export const disposeAppRuntime = (): Promise<void> => appRuntime.dispose()
```

Route modules import that Runtime and bind it to the adapter:

```ts
// app/api/users/[id]/route.ts
import { appRuntime } from '@/app/runtime'

const http = NextEffect.make(appRuntime)
```

Do not put this long-lived Runtime in an `await using` scope that ends during
module initialization; that would dispose it before exported handlers serve
requests. `NextEffect.make` stores only the Runtime supplied by the caller: it
does not create a process-global singleton or mutate hidden adapter state.
Sharing `appRuntime` is an application ownership choice. If a deployment
requires per-invocation ownership instead, use the existing `Runtime.use`
helper explicitly; the adapter never creates a Runtime per request by default:

```ts
export const GET = (request, context) =>
  Runtime.use(AppLive, (runtime) =>
    NextEffect.make(runtime).handler(() => getUser(context))(request, context)
  )
```

Each request creates one WebEffect execution and child Scope, installs
`CurrentRequest` and `CurrentAbortSignal`, and releases request-local Layers
before the handler Promise resolves. The request's
`AbortSignal` is linked into the execution signal, and concurrent requests keep
request Layers and context isolated.

The default success policy passes through a returned `Response`; other values
are encoded as `{ data: value }` JSON using the same strict serialization rules
as `better-effect/web`. A route may select at most one success policy:
`respond` handles a complete Response, `serialize` transforms a JSON-safe
value, and route-level `onSuccess` replaces the shared success policy. Shared
`onSuccess` and `onFailure` policies receive the native Request and route
context. Typed
`Result.err` failures use `onFailure` (or the redacted 500 default), while
thrown defects remain rejected. Policies must return a standards-compatible
`Response` and may be asynchronous. This adapter does not add Edge-runtime
support; use it only in hosts supported by the configured better-effect
Runtime.

Install Next.js only when this subpath is used:

```bash
bun add better-effect better-result next
```

`next` is an optional peer dependency, and `better-effect/next` uses only the
public native Route Handler shape, so the core and other entrypoints remain
usable without Next.js.

### Bun.serve fetch adapter

The optional `better-effect/bun` entrypoint is a small Bun-only adapter over
`WebEffect`. It does not create a Runtime, own a Bun server, install a router,
or make the Bun server an implicit Service. The route factory receives Bun's
`Request` and `Bun.Server` values explicitly:

```ts
import { Result } from 'better-result'
import { CurrentAbortSignal, Effect, Layer, Runtime, Service } from 'better-effect'
import { CurrentRequest } from 'better-effect/standard-services'
import { BunEffect } from 'better-effect/bun'

class AppService extends Service<AppService>()('AppService') {
  handle(url: string) {
    return url
  }
}

const AppLive = Layer.make(AppService)
const runtime = await Runtime.make(AppLive)
const http = BunEffect.make(runtime, {
  onFailure: (_error, request) =>
    Response.json({ error: 'Request failed', url: request.url }, { status: 500 })
})

const server = Bun.serve({
  port: 3000,
  fetch: http.handler((request, server) =>
    Effect.fn(async function* () {
      const app = yield* AppService
      const currentRequest = yield* CurrentRequest
      const signal = yield* CurrentAbortSignal

      return Result.ok({
        value: app.handle(request.url),
        currentUrl: (currentRequest.request as Request).url,
        port: server.port,
        aborted: signal.aborted
      })
    })
  )
})
```

`BunEffect.handler` invokes exactly one `WebEffect` request boundary. That
boundary supplies `CurrentRequest`, forwards the request signal, composes
request-local Layers, applies the configured failure/response policies, keeps
thrown defects rejected, and releases request resources before the handler
Promise resolves. Runtime-root resources remain shared and owned by `runtime`.

The application owns both long-lived resources and must shut them down
explicitly. Stop accepting requests before releasing root Services, then
release the Runtime:

```ts
await server.stop()
await runtime.dispose()
```

`server.stop()` is the Bun server lifecycle boundary; `BunEffect` does not
provide a `serve` helper or dispose either resource for you. Keep a single
application-owned shutdown Promise if shutdown can be requested more than once.
This Bun-specific entrypoint makes no Node compatibility claim.

### Hono request boundaries

The optional `better-effect/hono` entrypoint supplies Hono's middleware,
validator, and Context integration around the same Web request boundary used
by `better-effect/web`. It adapts Hono's Context to a standard Web `Request`,
then delegates the single `Runtime` execution, Result/defect handling, and
request Scope cleanup to that shared boundary. You only need to configure one
Hono middleware boundary per request; the adapter prevents duplicate
registrations from opening another execution.

Handlers can yield Services directly; the adapter provides `CurrentRequest`,
forwards `Request.signal`, and converts Results to Responses in one policy:

```ts
import { Hono } from 'hono'
import { Result } from 'better-result'
import { HonoEffect } from 'better-effect/hono'

const http = HonoEffect.make(runtime, {
  onFailure: (_error, c) => c.json({ error: 'Request failed' }, 400)
})
const app = new Hono()

app.use('*', http.middleware())
app.get(
  '/work-orders',
  http.gen(async function* () {
    const workOrders = yield* WorkOrderService
    const items = yield* Result.await(workOrders.list())
    return Result.ok(items)
  })
)
```

One or more Hono validators can precede the generator or handler callback, in
the order they should run. Their validated `c.req.valid(...)` inputs are
combined and inferred without a manual `Input` helper:

```ts
import { sValidator } from '@hono/standard-validator'

app.post(
  '/work-orders',
  http.gen(
    sValidator('json', createWorkOrderSchema),
    async function* (c) {
      const input = c.req.valid('json')
      const workOrders = yield* WorkOrderService
      const workOrder = yield* Result.await(workOrders.create(input))

      return Result.ok(workOrder)
    },
    { status: 201 }
  )
)
```

For multiple validators, pass them in order before the callback:

```ts
app.post(
  '/work-orders/:id',
  http.gen(validateParam, validateHeader, validateCreateWorkOrder, async function* (c) {
    const id = c.req.valid('param').id
    const key = c.req.valid('header')['X-Idempotency-Key']
    const input = c.req.valid('json')
    return Result.ok({ id, key, input })
  })
)
```

The validator middleware runs before the Program and short-circuits with its
own `Response` when validation fails. `http.handler` accepts the same ordered
validator arguments followed by the program factory and options.

Install `hono` only when this subpath is used. The main entrypoint does not
load the framework. The default Hono failure policy redacts every non-`Response`
failure value to `{ error: 'Internal Server Error' }` with status 500. An
explicitly returned `Response` failure is intentionally passed through
unchanged. A custom `onFailure` policy should serialize only safe, intentional
domain details.

Service and Scope access share one `RuntimeContext`. The published Runtime
entrypoint is officially supported on Node.js and Bun, where `AsyncLocalStorage`
is the default context storage. The `better-effect/runtime/explicit` subpath
provides `ExplicitRuntimeContextStorage` as a manually managed, sequential
strategy only when the package entrypoint and host can load it. One instance
supports one non-overlapping async flow and rejects concurrent overlap. Using
it does not make the package generally usable in browsers, Deno, Cloudflare
Workers, or other non-Node hosts; separate explicit instances are not a general
concurrent-isolation strategy.

If a program asks that Runtime for a Service its environment does not provide, TypeScript rejects the call.

```text
yield* Database
      │
      ▼
program requires Database
      │
      ▼
Layer provides Database?
      │
   no ├──────────► TypeScript error
      │
     yes
      ▼
Runtime can execute it
```

We call this **typechecked wiring**.

The Services your code uses, the implementations your Layers provide, and the programs your Runtime executes participate in the same type-level contract.

A Layer's public type is `Layer<Provided, Required>`. `Provided` is the Service
instance union produced by the Layer and `Required` is only the external
requirement union left after composition. Preserve inferred Layers when possible;
use `satisfies Layer<Provided, Required>` when checking an application boundary
without erasing provider provenance.

Generic infrastructure that intentionally erases this metadata can use the
explicit `Layer.Any` sentinel, including for an empty Layer. Bare Layers,
partial-`any` shapes and concrete unions such as `Layer<A> | Layer<B>` are not
implicit unchecked boundaries.

### Discover type helpers from their API

Public type helpers are also grouped under the runtime API they describe:

```ts
import type { Effect, Layer, Runtime, Scope, Service } from 'better-effect'

type Program = ReturnType<UserRepository['findUser']>
type Success = Effect.Success<Program>
type Failure = Effect.Error<Program>
type Dependencies = Effect.Requirements<Program>
type Services = Layer.Provided<typeof AppLive>
type Missing = Layer.Missing<typeof AppLive>
type AppRuntime = Runtime.For<typeof AppLive>
type DatabaseTag = Service.Tag<Database> // 'Database'
type DatabaseToken = Service.TokenOf<Database> // Service.Token<'Database', Database>
type Outcome = Scope.Outcome
```

These are declaration-only aliases and add nothing to the JavaScript bundle.
The associated `Layer` helpers are intentionally namespaced; use
`Layer.Provided`, `Layer.Required`, `Layer.Missing`, `Layer.Complete` and `Layer.Any` rather than
low-level provider metadata names.

`Layer.complete(layer)` is a runtime identity that checks a composition root
immediately, so missing Services are reported where the Layer is assembled.

### Lifecycle-only Layers

Use `Layer.scopedDiscard` for application components that need startup and
shutdown ownership but are not themselves a Service:

```ts
const PollerLive = Layer.scopedDiscard(
  () => startPoller(),
  (poller, outcome) => poller.stop(outcome)
)

const AppLive = Layer.complete(Layer.merge(ConfigLive, PollerLive))
```

The acquisition runs once when `Runtime.make` activates the Layer, after
provider registration and optional warmup. The release belongs to the Runtime
root Scope, runs in reverse activation order, and receives the final
`ScopeOutcome`. A contextual acquisition can use `yield*` with
`Layer.scopedDiscard` (or the explicit `Layer.scopedDiscardGen`) and retains
those Service requirements even though the Layer provides `never`:

```ts
const PollerLive = Layer.scopedDiscard(
  async function* () {
    const config = yield* Config
    return startPoller(config)
  },
  (poller, outcome) => poller.stop(outcome)
)
```

For startup programs, `Layer.effectDiscard` accepts only
`Effect.Program<void, never, R>`-compatible programs. A typed failure must be
handled by the program before it is made a lifecycle entry; it is not silently
converted into a Runtime defect.

---

## Why better-effect?

`better-result` already gives TypeScript applications an excellent model for typed failures.

But typed errors are only one part of a growing application.

Eventually you also need to answer:

- What does this service depend on?
- Did the application provide every dependency?
- Can this program run in this environment?
- How do I replace implementations in tests?
- Who owns this database connection?
- When should this resource be released?

Those problems are often discovered through container errors, startup failures, test setup, or manual composition-root maintenance.

Effect has powerful ideas for solving them.

`better-effect` explores a smaller path:

**keep `better-result`, Promises and normal TypeScript — borrow the architectural ideas that make dependencies and resource lifetimes easier to reason about.**

### Know your dependencies before runtime

Services can be requested directly:

```ts
const database = yield * Database
```

That access is also captured by the type system.

Layers know both what they provide and what their Services require. Incomplete environments can therefore fail during typechecking instead of application startup.

Runtime keeps that environment information and checks programs against it when they run.

### Compose application environments

Layers describe implementations without making your application code depend on a specific DI container.

```ts
const AppLive = Layer.merge(DatabaseLive, UserRepositoryLive, AuthServiceLive)
```

Testing can replace implementations explicitly:

```ts
const AppTest = Layer.override(AppLive, DatabaseTest)
```

The environment contract remains typed after the override.

### Own resource lifetimes

Some dependencies are values.

Others own connections, sessions, files or other resources.

`Layer.scoped`, `Layer.scopedGen`, `Layer.scopedDisposable`, `Effect.acquireRelease`,
`Effect.acquireReleaseResult`, `Effect.acquireDisposable`, `Effect.add` and `Scope` make their
lifetime explicit.

```ts
const DatabaseLive = Layer.scoped(
  Database,
  () => Database.connect(),
  (database, outcome) => database.close(outcome)
)
```

Runtime owns the application lifetime and safely releases scoped resources when that lifetime ends.

Resources acquired during an individual execution belong to that execution instead.

When an existing API already returns a `Result`, keep its typed failure channel while
registering only successful acquisitions:

```ts
const connection =
  yield *
  Effect.acquireReleaseResult(
    () => pool.connect(),
    (connection, outcome) => connection.close(outcome)
  )
```

An `Err` is returned unchanged and is never released. Thrown or rejected acquisition
defects use the normal `UnhandledException` channel; release failures remain Scope
cleanup failures rather than widening the acquisition error type.

For values that implement JavaScript disposal, use the disposable helpers instead of
repeating a release callback. Async disposal is preferred when both protocols exist:

```ts
const file = yield * Effect.acquireDisposable(() => openFile(path))

const DatabaseLive = Layer.scopedDisposable(Database, () => Database.connect())
```

`Effect.acquireDisposable` belongs to the current execution Scope. `Layer.scopedDisposable`
keeps the client alive across executions and disposes it with the Runtime root; the DI
backend never owns that release.

### Keep your runtime choices

`better-effect` is not a replacement implementation of Effect.

It does not introduce a fiber runtime, scheduler, streams, queues or a lazy runtime instruction tree.

Its public `Effect<A, E, R>` is only a type-level Result facade. `Effect.gen` builds on
`better-result` generator composition while carrying Service instance requirements through the
TypeScript type system.

Dependency resolution stays behind a pluggable backend.

Your application can keep using ordinary Promises and existing libraries.

### Optional standard services

Small host-backed services live behind `better-effect/standard-services` so the
core package stays explicit:

```ts
import { Clock, ClockTest } from 'better-effect/standard-services'
import { Runtime, ServiceRuntime } from 'better-effect'

const ClockTestLive = ClockTest.layer(new Date('2025-01-01T00:00:00.000Z'))
const runtime = await Runtime.make(ClockTestLive)
const now = await runtime.run(async () => ServiceRuntime.resolve(Clock))
await runtime.dispose()
```

`IdGenerator` uses the host's cryptographic `crypto.randomUUID()` and is also
opt-in. Use `IdGeneratorTest` to make entity creation deterministic without
introducing a domain-specific ID type:

```ts
import { Result } from 'better-result'
import { Effect, Layer, Service } from 'better-effect'
import { IdGenerator } from 'better-effect/standard-services'
import { IdGeneratorTest, TestRuntime } from 'better-effect/testing'

class User extends Service<User>()('User') {
  constructor(readonly id: string) {
    super()
  }
}

const createUser = Effect.fn(async function* () {
  const ids = yield* IdGenerator
  return Result.ok(new User(ids.next()))
})

const result = await TestRuntime.use(
  Layer.merge(),
  { idGenerator: new IdGeneratorTest(['user-1']) },
  (test) => test.run(createUser)
)
// Result.ok(User { id: 'user-1' })
```

`IdGeneratorTest.from((index) => ...)` provides an unbounded deterministic
sequence; its first factory index is zero and increases monotonically. The
entrypoint also provides `Random`/`RandomSeeded`, `Logger`/`LoggerTest`, `Config`,
`CurrentRequest`, and the compatible `CurrentAbortSignal` bridge. None is
installed implicitly; compose a normal Layer or use the provided test helpers.

`Clock.sleep` keeps the original `clock.sleep(milliseconds)` form and accepts
an optional `AbortSignal`. Invalid delays still throw synchronously. Aborted
sleeps clear their timer and listener; a supplied `signal.reason` is rejected
unchanged, otherwise the rejection is an `AbortError`-named `DOMException`.

Use the same signal in polling, retry delays and expiration checks:

```ts
const poll = async (clock: Clock, signal: AbortSignal) => {
  while (true) {
    const status = await readStatus()
    if (status.ready) return status
    await clock.sleep(1_000, { signal })
  }
}

const retry = async <A>(operation: () => Promise<A>, clock: Clock, signal: AbortSignal) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt === 2) throw error
      await clock.sleep(100 * 2 ** attempt, { signal })
    }
  }
}

const waitUntilExpired = async (clock: Clock, expiresAt: number, signal: AbortSignal) => {
  while (clock.now().getTime() < expiresAt) {
    await clock.sleep(Math.min(expiresAt - clock.now().getTime(), 1_000), { signal })
  }
}
```

`ClockTest` orders sleeps by absolute deadline and FIFO for equal deadlines.
`pendingSleeps` is a readonly count. `advanceToNext()` returns `false` when
there is no pending sleep; `runAll({ maxSteps })` advances repeatedly and
awaits one microtask checkpoint between deadlines so resumed code can schedule
its next wait:

```ts
const clock = new ClockTest(0)
const task = (async () => {
  await clock.sleep(100)
  await clock.sleep(50)
})()

await clock.runAll({ maxSteps: 10 })
await task
// clock.now().getTime() === 150
```

`setTime` may move backward. Pending sleeps keep their absolute deadlines and
resolve only when reached. `ClockTest` does not virtualize `Date`, global
`setTimeout` or the JavaScript microtask queue.

For typed environment configuration, bind a Standard Schema directly to a
reusable descriptor:

```ts
import { Result } from 'better-result'
import { Effect } from 'better-effect'
import { Config } from 'better-effect/standard-services'

const AppConfig = Config.fromEnv({ schema: EnvSchema, dotEnvPath: '.env' })

const program = Effect.fn(async function* () {
  const config = yield* AppConfig
  return Result.ok(config)
})
```

Use `Config.schema(schema)` with `Config.layer(source)` or
`Config.layerFromEnv(options)` when several descriptors should share an
explicitly replaceable provider.

When configuration should be consumed through a Service token, bind the schema
to that token so `get` only accepts keys from the decoded schema output:

```ts
const AppConfig = Config.withSchema(EnvSchema)
const AppConfigLive = AppConfig.layerFromEnv({ dotEnvPath: '.env' })

const program = Effect.fn(async function* () {
  const config = yield* AppConfig
  return Result.ok(config.get('DATABASE_URL'))
  //             ^ autocomplete is restricted to EnvSchema output keys
})
```

`config.get(...)` reads the validated schema output, with the value type inferred
from the selected key. Use `Config.schema(schema)` or
`Config.fromEnv({ schema })` when the complete transformed output is needed.

---

## How it compares

|                               | better-result | better-effect       | Effect          |
| ----------------------------- | ------------- | ------------------- | --------------- |
| Typed success/failure         | ✓             | ✓ via better-result | ✓               |
| Generator composition         | ✓             | ✓                   | ✓               |
| Contextual Services           | —             | ✓                   | ✓               |
| Dependency requirements       | —             | ✓                   | ✓               |
| Checked environments          | —             | ✓                   | ✓               |
| Scoped resource lifetimes     | —             | ✓                   | ✓               |
| Pluggable external DI backend | —             | ✓                   | different model |
| Fiber runtime                 | —             | —                   | ✓               |
| Structured concurrency        | —             | —                   | ✓               |
| Streams / queues / schedules  | —             | —                   | ✓               |
| Full effect ecosystem         | —             | —                   | ✓               |

### Choose `better-result`

When typed error handling and Result composition are enough.

### Add `better-effect`

When your Result-based application also needs contextual Services, typechecked application wiring, composable environments, or resource lifetime management.

### Choose Effect

When you want a complete effect system and its runtime, concurrency model, dependency model, resource management and broader ecosystem.

`better-effect` is inspired by some of those ideas. It is intentionally not a reimplementation of the whole system.

---

## Core ideas

### Typechecked wiring

**Service requirements → Layer completeness → Runtime validation**

Use a Service and its requirement follows the program.

Build an incomplete environment and TypeScript tells you what is missing.

Run a program against an incompatible Runtime and the mismatch remains visible at compile time.

### Composable environments

**Layer → merge → override → DI backend**

Describe application implementations independently from the container responsible for resolving them.

Compose production environments and replace selected implementations for tests.

### Scoped lifetimes

**Scope → scoped Layers → acquire/release → graceful Runtime disposal**

Make ownership explicit for resources that need cleanup.

Application resources live with the Runtime. Execution resources live with the execution.

### better-result underneath

**Result → Result.gen → Effect.gen / Effect.fn → pipe**

Keep `better-result` as the source of truth for typed successes, failures, short-circuiting
and generator control flow. `Effect.gen` delegates to `Result.gen`; it adds only the
declaration-only Service requirements that TypeScript needs to check the application environment.
At runtime, an `Effect<A, E, R>` is still a `better-result` Result; the requirements exist
only in the type. `Effect.Requirements`, `Layer.Provided`, `Layer.Required` and
`Runtime.For` expose tagged Service instance unions.

For a linear workflow, `pipe` composes the same kind of program without introducing a
second Result model or a lazy Effect runtime:

```ts
import { Effect, pipe } from 'better-effect'

const program = pipe(
  findUser(id),
  Effect.map((user: User) => user.email),
  Effect.andThen(loadPermissions),
  Effect.mapError((cause: LoadUserError | PermissionError) => new ApplicationError({ cause }))
)
```

The combinators keep the `better-result` semantics: `Effect.map` changes the success
type, `Effect.mapError` changes the error type, and `Effect.andThen` only calls the next
step after an `Ok`. Use `Effect.andThenAsync` when the next operation returns a
`Promise<Result>`; it always returns a Promise, including when the source is synchronous
or already an `Err`. The pipeline carries the requirements of every step, so Runtime
still rejects it when its Layer does not provide every required Service.

Observation helpers such as `Effect.tap`, `Effect.tapError`, and `Effect.tapBoth`
run only the active branch and return the original Result, so logging or metrics
do not change the pipeline's value or requirement channel. The async variants
`Effect.tapAsync`, `Effect.tapErrorAsync`, and `Effect.tapBothAsync` accept
`PromiseLike<void>` observers, always return a Promise, and preserve the source
requirements. They delegate branch selection and defect handling to
`better-result`; only the active observer runs, and a successful observation
returns the exact original Result. They do not create a Scope or resolve
Services inside the callback.

```ts
const audited = pipe(
  loadUser(userId),
  Effect.tapAsync((user) => metrics.recordUserLoaded(user.id)),
  Effect.tapErrorAsync((error) => metrics.recordUserFailure(error))
)
```

`Effect.matchError` exhaustively maps a tagged `Err` union, while
`Effect.matchErrorPartial` maps selected tags and retains unhandled variants in
the resulting error union. Both delegate to `better-result`'s tagged-error
matchers and preserve the source success and requirement channels.

Use `Effect.recover` or `Effect.recoverAsync` for an explicit fallback Result;
the fallback is evaluated only when the input is an `Err`, and its Service
requirements are included in the resulting type.

`Effect.flatten` removes one nested Result layer. `Effect.as` and `Effect.asVoid`
replace successful values while leaving the error and requirement channels intact.

`Effect.match` supports ordinary branch values as well as branch Effects. Only
the selected handler runs; Effect-valued handlers contribute both possible
error and Service requirement channels to the result type.

`Effect.all` collects already-created Effects in input order, while `Effect.zip`
is the two-value form; both union every input's error and Service requirements
and retain `better-result` short-circuiting.

Use `Effect.gen` for larger workflows with several intermediate values, branches or
procedural logic that already has a resolver. Use `Effect.fn` when the workflow should
start at a Runtime boundary. Use `pipe` for concise, linear composition; all three
keep dependency checking in the `better-effect` layer.
