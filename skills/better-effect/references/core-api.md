# Core contracts

Read this for generators, type inference, contextual dependencies, lifetimes,
standard services, tests, and diagnostics. For request hosts, continue with
[frameworks](frameworks.md). Public source: [core package](https://github.com/nitoba/better-effect/tree/main/packages/better-effect).

## Effect, Program, and Result are different boundaries

`Effect<A, E, R>` is a declaration-only facade over a nominal `better-result`
Result. `R` is a union of tagged **Service instances**, not constructor types.
The constructors remain the tokens used by `yield*`, Layers, and backends.
There is no Effect TS instruction interpreter. Use the namespaced helpers
`Effect.Success`, `Effect.Error`, `Effect.Requirements`, `Service.Tag`,
`Service.TokenOf`, and `Scope.Outcome` when naming these contracts; do not
import private type metadata.

| Value at the call site | Correct consumption |
| --- | --- |
| `Result<A, E>` / synchronous Effect | `yield* result` |
| `Promise<Result<A, E>>` / async Effect | `yield* Result.await(promise)` |
| Core `Effect.fn(...)` Program | `runtime.run(program)` or lazy Program composition |
| Core Program invoked inside an async generator | `yield* Result.await(Promise.resolve(program()))` |
| Integration's yieldable Operation | `yield* operation`; do not wrap it again |
| Plain Promise that may reject | Normalize expected infrastructure failures once with `Result.tryPromise`; otherwise preserve the defect policy |

`Effect.gen` starts immediately; use it only where execution is already active
or where no contextual capability is needed. `Effect.fn` takes a zero-argument
generator and returns a lazy callable. Parameters belong in an ordinary factory:

```ts
import { Effect, Service } from 'better-effect'
import { Result } from 'better-result'

class Labels extends Service<Labels>()('@app/Labels') {
  render(id: string) {
    return `item:${id}`
  }
}

const renderLabel = (id: string) =>
  Effect.fn(function* () {
    const labels = yield* Labels
    return Result.ok(labels.render(id))
  })
```

Pass `renderLabel('42')` to a Runtime providing `Labels`. Do not return a raw
string from the generator, construct an eager Effect before `runtime.run`, or
assume `yield* renderLabel('42')` works: the core Program is not an iterator.

Use `Effect.*` combinators for already-created Results and `Program.*` for
lazy Programs. `Program.map`, `mapError`, `andThen`, `tap`, `tapError`, and
`recover` preserve laziness. `andThen` unions error/requirement channels;
`recover` removes the handled source error channel and includes the recovery's
errors and requirements. `pipe(program, Program.named('operation.name'))`
adds diagnostic metadata without execution.

`Program.all`, `Program.forEach`, and `Program.allResults` accept bounded
positive `concurrency` and an optional diagnostic `name`. Results retain input
order. `all`/`forEach` stop scheduling on failure and let already-started work
settle. `allResults` retains typed child Results inside a successful collection;
defects still stop scheduling and reject. None force-cancels siblings.

## Services and Layers

Use stable non-empty literal tags, preferably namespaced across packages.
`X.of(implementation)` type-checks `Service.Contract<X>` and returns the same object;
it does not validate input, run a constructor, clone, proxy, or satisfy private-field
invariants. Use a real instance where those invariants matter.

| Provider/composition API | Purpose |
| --- | --- |
| `Layer.make(Token)` / `Layer.make(Token, factory)` | Lazy unscoped provider |
| `Layer.succeed(Token, value)` | Existing value; does not invent ownership |
| `Layer.gen(Token, generator)` | Contextual acquisition; yield Services, return provider |
| `Layer.scoped(Token, acquire, release)` | Root-owned resource; simple `release(value)` |
| `Layer.scopedDisposable(Token, acquire)` | Root cleanup through the acquired value's disposal protocol |
| `Layer.scopedGen(Token, generator, release)` | Contextual resource; `release(value, outcome)` |
| `Layer.empty` | Stable empty Layer value, not a function |
| `Layer.merge(...)` | Compose providers; duplicates are not overrides |
| `Layer.override(base, replacements...)` | Explicit, compatible replacement |
| `Layer.alias({ from, to })` | Expose the same compatible implementation under another token |
| `Layer.complete(layer)` | Identity at runtime, completeness check at the composition root |

Acquisition generators are **not** Result workflows. They return the raw
provider; Layer has two channels (`Provided`, `Required`), not an error channel.
The explicit lifecycle-object overload of scoped/scopedGen supports quiesce
and outcome-aware release. For typed startup decisions, handle the Result deliberately before using a
lifecycle entry. Missing providers must not be fixed with casts.

Prefer inference or `satisfies Layer<Provided, Required>` so provider provenance
survives later overrides. Use `Layer.Provided`, `Required`, `Missing`, `Complete`,
and `Any` rather than private metadata. `Layer.Any` is an explicit unchecked
adapter boundary, not an application convenience.

An alias does not construct or own a second resource; its source remains a
requirement until supplied. Distinct tags with identical method shapes are
still distinct dependencies.

## One Runtime; multiple executions

`Runtime.make(AppLive)` uses `MapLayerBackend` by default. The optional
`ItiLayerBackend` comes from `better-effect/adapters/iti`; the compatibility
`MemoryLayerBackend` is exported by `better-effect/testing`. DI backends resolve
providers; the Runtime/Scope owns their lifetimes.

Use `await using`, `Runtime.use`, or an explicit `try/finally` with
`runtime.dispose()`. A server keeps one Runtime for many executions; a one-shot
`Runtime.run(AppLive, program)` is appropriate for independently scoped work.
Preserve `Runtime.For<typeof AppLive>` when passing the owner across modules.

`runtime.runWith(RequestLive, program)` installs an execution-local Layer. It
can depend on root Services, but it does not mutate the shared environment.
Do not store request credentials, a transaction, or a current user in a root
singleton. Root provider construction must not capture a request-only Service.

Provider acquisition is lazy. `warmup: true` or `runtime.warmup()` acquires
providers before readiness. Lifecycle-only entries are activated by Runtime
startup; merely declaring a provider Layer does not prove its worker/server
has started.

`yield* Runtime.executor<RequiredService>()` captures a non-owning
`Runtime.Executor<R>` in an active execution or Layer acquisition. It retains
`run`, `runWith`, and the explicit managed `runWithManaged` capability, but no
`dispose`, backend, or Scope ownership. Host code may use `runtime.executor`.
Prefer a framework's existing bridge instead of hand-building managed execution.

## Lifetimes, tasks, and shutdown

Shared pools/clients belong to Layer-scoped providers. Execution-local files,
locks, readers, and similar resources belong to `Effect.acquireRelease`.
`Effect.add` accepts an **already acquired disposable**, not a factory, Promise,
or plain value. `Scope` provides hierarchical ownership; `Resource.acquireUseRelease`
remains useful for one local Result-based acquire/use/release transaction.

Child Scopes close before parent finalizers; finalizers run LIFO. Contextual
code may register cleanup but must not close the Runtime's contextual Scope.
Preserve the primary operation failure when cleanup also fails; expose
secondary cleanup diagnostics through the documented observer. Do not infer
success from an intermediate Result or an arbitrary object's `status` field.

For lifecycle-only components, use `Layer.scopedDiscard(acquire, release)` or
its `{ quiesce, release }` lifecycle form; contextual acquisition is supported
by `scopedDiscard`/`scopedDiscardGen`. It provides `never` but retains required
Services. Use `Layer.effectDiscard` only with a `Program<void, never, R>`:
handle typed failures before making the Program a startup lifecycle entry.

`yield* Effect.forkScoped(program)` starts a child task owned by the current
execution/lifecycle Scope. It inherits Services, has its own cooperative signal,
and is interrupted and awaited before parent resources are released.
`task.await()` exposes its Result or throws its defect; `task.awaitExit()`
allows non-throwing inspection of the exit. A startup Program that forks a
long-lived task should return after establishing it, not await its infinite
loop and prevent application readiness. Durable work belongs in MQ, not a
process-local task.

Read `CurrentAbortSignal` and pass it to cooperative I/O. Runtime shutdown
quiesces ingress, drains admitted executions, optionally aborts after grace,
and releases resources. New executions are rejected once quiescing starts.
It cannot forcibly terminate arbitrary Promises or undo a completed write.

## Standard services and observability

`better-effect/standard-services` provides `Clock`/`ClockLive`, `Random`/
`RandomLive`, `Logger`/`LoggerLive`, `IdGenerator`/`IdGeneratorLive`, `Config`/
`ConfigLive`, `CurrentRequest`, and `CurrentAbortSignal`. Provide the capabilities
actually required by the Program/integration; importing a token does not install
its Layer. `Clock.now()` returns a Date. `Clock.sleep(ms, { signal })` is
cooperative; `Random.next()` is not a cryptographic identifier generator.

Keep environment reads/validation at the Config boundary. `Config.fromEnv({
schema, dotEnvPath?, envSource? })` is a reusable async-yieldable descriptor;
`yield* descriptor` reads and validates without requiring a Config provider.
Explicit environment values override dotenv values, and schemas perform coercion.
`Config.schema(schema)` instead reads the contextual provider installed through
`Config.layer(source)` or `Config.layerFromEnv(options)`.

`Config.withSchema(schema)` gives a schema-bound token with typed `get(key)` and
its own layer/layerFromEnv helpers. It validates during Layer acquisition, so
invalid configuration fails startup rather than appearing as a Program Result.
Use the descriptor forms when validation belongs in the typed failure channel.
Do not confuse these boundaries or log raw source values/secrets.

Use `RuntimeObserver`, `RecordedRuntimeObserver`, and `RuntimeGraphObserver`
for lifecycle assertions and diagnostics. `runtime.inspect()` returns a detached
snapshot, not a synchronization/readiness primitive. A graph observer reports
what was resolved, not every statically possible dependency.

`better-effect/opentelemetry` supplies `OpenTelemetryRuntimeObserver.make`.
The application owns its tracer/provider, SDK, exporter, and flush lifecycle.
Opt in to Service/lifecycle/shutdown telemetry and attribute allowlists; causes,
stacks, credentials, and arbitrary request attributes are not safe defaults.
Core tracing does not automatically instrument or propagate HTTP/database calls.

## Tests and host limits

`TestRuntime.make/use` from `better-effect/testing` wraps the same production
Layer/Runtime with explicit overrides and deterministic Services. Use `ClockTest`,
`RandomSeeded`, `LoggerTest`, and `IdGeneratorTest` rather than global monkey
patches. Observe successful cleanup, Err, defects, cancellation, and concurrent
request isolation. Keep type tests for missing requirements and incompatible
overrides, not just runtime tests for successful resolution.

`layerBackendContract` and `runtimeContextStorageContract` are runner-neutral
conformance scenarios for adapter authors. `better-effect/runtime/node` exposes the Node context-storage boundary, which
supports concurrent execution. `better-effect/runtime/explicit` exposes
`ExplicitRuntimeContextStorage`, which is sequential and rejects
overlapping roots. Its existence does not certify browsers, Edge, Deno, or
Cloudflare Workers. The published Runtime support boundary is Node.js and Bun.
