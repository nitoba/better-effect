# better-effect

**Effect-like dependency safety for better-result.**

Type your errors with `better-result`. Typecheck the rest of your application wiring with `better-effect`.

Use Services directly inside `Effect.fn` Programs (or eager `Effect.gen` workflows), compose implementations into application environments, and let TypeScript catch missing dependencies before your application starts — while keeping Promises, `better-result`, and your DI backend.

```bash
bun add better-effect better-result
```

The tested runtime matrix is Node.js 24 and Bun 1.3.14. The package's default
runtime context uses Node/Bun async context propagation.

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

And the contract does not disappear after startup.

A Runtime also knows which Services exist in its environment:

```ts
const inspectDatabase = Effect.fn(async function* () {
  const database = yield* Database

  return Result.ok(database)
})

await runtime.run(inspectDatabase)
```

Runtime boundaries inspect only nominal `better-result` values: `Result.err`
becomes a failed execution, while a plain object with `status: 'error'` is
still a successful value. Intermediate Results do not close the execution
Scope.

`Effect.gen` remains eager for code that already runs inside a resolver and
Scope. `Effect.fn` captures the generator as a lazy `Program` for Runtime
boundaries; the callback form remains supported for compatibility.

`Program.all` keeps a collection lazy until the returned Program is run. Pass
`{ concurrency: n }` for a positive bounded FIFO worker pool; values retain
input order. If a Program returns an error or throws, scheduling stops, already-
started Programs are allowed to settle, and the deterministic primary failure remains selected;
there is no cancellation or Fiber scheduler.

`Runtime.make(AppLive)` and `Runtime.run(AppLive, program)` use the built-in
`MapLayerBackend`. Pass `{ backend: new ItiLayerBackend() }` when an external
container is needed; `MemoryLayerBackend` remains its compatibility alias from
`better-effect/testing`.

Runtimes are async disposables, so request-scoped code can use:

```ts
await using runtime = await Runtime.make(AppLive)
const result = await runtime.run(program)
```

Or let `Runtime.use` own the lifetime:

```ts
const result = await Runtime.use(AppLive, (runtime) => runtime.run(program))
```

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
events without coupling the core to an observability SDK:

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

For request-local context or overrides, add a Layer only to that execution:

```ts
const result = await runtime.runWith(RequestLive, handleRequest)
```

The request Layer may use root Services, while its scoped providers are closed
with the execution Scope and never change the shared Runtime environment. Its
external requirements must be provided by the Runtime, and the Hono failure
handler/request-Layer types are checked at the adapter boundary.

### Hono request boundaries

The optional `better-effect/hono` entrypoint runs one Runtime execution and
Scope around each request. Handlers can yield Services directly; the adapter
provides `CurrentRequest`, forwards `Request.signal`, and converts Results to
Responses in one policy:

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

Hono validators can precede the generator or handler callback. Their validated
`c.req.valid(...)` inputs are combined and inferred without a manual `Input`
helper:

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
load the framework. The default Hono failure response redacts details from both
`Error` and non-`Error` failure values; a custom `onFailure` policy should
serialize only safe, intentional domain details.

Service and Scope access share one `RuntimeContext`. Node/Bun uses
`AsyncLocalStorage` by default. `ExplicitRuntimeContextStorage` is available
for hosts without transparent propagation, but one instance supports only one
non-overlapping async flow and rejects concurrent overlap.

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

`Layer.scoped`, `Layer.scopedGen`, `Effect.acquireRelease`, `Effect.add` and `Scope` make their lifetime explicit.

```ts
const DatabaseLive = Layer.scoped(
  Database,
  () => Database.connect(),
  (database, outcome) => database.close(outcome)
)
```

Runtime owns the application lifetime and safely releases scoped resources when that lifetime ends.

Resources acquired during an individual execution belong to that execution instead.

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

The entrypoint also provides `Random`/`RandomSeeded`, `Logger`/`LoggerTest`,
`Config`, `CurrentRequest`, and the compatible `CurrentAbortSignal` bridge. None
is installed implicitly; compose a normal Layer or use the provided test
helpers.

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
do not change the pipeline's value or requirement channel.

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
