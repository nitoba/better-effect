# better-effect-mq

**Experimental durable message-queue protocol foundations for `better-effect`.**

`better-effect-mq` defines a storage-neutral durable queue protocol and a small
Worker supervisor for `better-effect`. Version 0.1 exposes JSON-safe records,
nominal identities, deterministic claim ordering, persisted failure envelopes,
pure state transitions, explicit JSON/Standard Schema conversion, the
storage-neutral `JobStore` Service contract, and `Worker.start`/`Worker.use`.
It does not open connections or provide a storage adapter.

The package uses [`better-effect`](https://github.com/nitoba/better-effect)'s
Service type and [`better-result`](https://github.com/nitoba/better-result)'s
Result model; it does not depend on the full Effect library.

## Protocol version and delivery guarantee

```ts
import { protocolVersion } from 'better-effect-mq'

protocolVersion // 1
```

`protocolVersion` is the experimental durable wire/state contract and is `1` in
v0.1. `better-effect-mq` offers **at-least-once delivery**: a job confirmed under
the current lease is not delivered again by the normal protocol; a job whose
settlement was not persisted may be delivered again.

A handler can perform an external side effect and crash before its settlement
(or ACK) is persisted. That side-effect-before-ACK window is expected, not a
transactional guarantee. Handlers must make external effects idempotent, usually
with the job ID or an application idempotency key. A lease token prevents an
old worker from settling a newer delivery, but it cannot undo an already
executed external effect.

## Storage-neutral records

`JobRecord`, `AttemptRecord`, `PersistedBackoff`, and `SerializedJobFailure`
contain only strings, numbers, enums, and `JsonValue`. Brands are
declaration-only; their persisted representation is still a string. No live
`Error`, `Result`, `Service`, driver, connection, request, headers, cause, or
stack is part of a persisted DTO.

```ts
import { JobId, QueueName, WorkerId } from 'better-effect-mq'

const id = JobId.make('email-123')
const queue = QueueName.make('emails')
const worker = WorkerId.make('worker-a')
```

Identity constructors return a `better-result` `Result` and reject non-string or
empty values. `JobId` additionally requires well-formed Unicode scalar text:
unpaired UTF-16 surrogates are rejected rather than replaced. Accepted identity
strings are preserved exactly: they are not trimmed, case-folded, normalized, or
otherwise canonicalized. `metadata` is stricter than a general JSON value: it
must be a non-null plain object whose own enumerable string keys all map to
strings. Primitive values, arrays, null, symbols, inherited fields, and unsafe
accessors are rejected.

`SerializedJobFailure` has a deliberately small whitelist:

- `kind`: `typed`, `defect`, `encode`, `timeout`, `decode`, `stalled`, or `cancelled`;
- optional safe `code`;
- redacted safe `message`;
- optional JSON-safe `data` selected by the application;
- `retryable`;
- integer epoch-millisecond `recordedAt`.

The protocol never calls `TaggedError.toJSON()` to create this envelope and has
no generic `fromError` copier. `JobCodecFailure` remains exported for
protocol compatibility. Portable codec operations use the more specific
`JobEncodeFailure` and `JobDecodeFailure`
errors; all three errors are tagged and can be identified by their `_tag` even
when values came from a duplicated package copy.

All public DTO validators accept untrusted persistence values, reject unknown
own top-level fields, and return a canonical copy. JSON payloads, metadata, and
failure data are recursively copied and frozen; functions, live errors, symbols,
accessor failures, and other non-JSON values are rejected as
`JobDefinitionError` without mutating the input.

## Retry, failure, and timeout policies

Retry policies are immutable, callback-free values for durable schedules:

```ts
const policy = Retry.exponential({
  initialDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 60_000,
  maxAttempts: 5
})
```

`Retry.fixed`, `Retry.linear`, and `Retry.exponential` persist only validated
backoff data; `Retry.custom` remains in the worker definition and is evaluated
synchronously, never by a store. `maxAttempts` includes the first execution and
must agree with `defaults.attempts` when both are supplied. Jitter is symmetric
multiplicative jitter in `[1-jitter, 1+jitter]`, with a deterministic random input
for `Retry.delay`; final delays are integer milliseconds clamped to `maxDelayMs`
and `Number.MAX_SAFE_INTEGER`. `Retry.never()` means exactly one execution.

Typed failures are retried only when `retryable` returns true. Use
`Job.unrecoverable(failure)` for object failures that must not retry; primitive
failures cannot carry this process-local identity marker. Defects retry by
default (`retryDefects: false` disables that), while decode and encode failures
are terminal. `timeoutMs` aborts the attempt cooperatively and is persisted per
job; the exported `JobTimeoutError` is used as the abort reason. The Worker
re-checks the deadline at the single settlement submission gate, so a timeout
that wins before adapter invocation is persisted as timeout retry/fail and
cannot be replaced by `complete`. Once an adapter settlement call has begun,
the adapter owns its non-cancellable mutation: the observed applied outcome
wins (the Worker does not pretend it can retract it), while fencing and the
attempt ledger prevent a duplicate settlement. `onJobFailure` is a best-effort
callback invoked only after an applied terminal or retry settlement.

## Portable codecs and trust boundaries

`Codec` is deliberately storage-neutral and requirement-free in v0.1: its
encode/decode callbacks cannot yield a `Service`. Custom callbacks return a
completed `Result` or requirement-free better-effect `Effect`, optionally
wrapped in a `PromiseLike`; raw values are not part of the callback contract.
Keep contextual I/O outside the codec and pass a completed result to
`Codec.make`.

```ts
import { Codec } from 'better-effect-mq'

const payload = Codec.json<{
  readonly recipient: string
  readonly attempts: number
}>()

const encoded = payload.encode({ recipient: 'ada@example.test', attempts: 1 })
const decoded = payload.decode({ recipient: 'ada@example.test', attempts: 1 })
```

The primitive representations are identity strings, finite numbers, booleans,
`null`, and `undefined` only after decoding `Codec.void` from persisted `null`.
`Codec.json()` validates an object/array graph iteratively, rejects accessors,
cycles, class instances, `Date`, `Map`, `Set`, `Error`, non-finite numbers, and
other non-JSON values, and accepts at most 1,024 structural levels. It reads
only own data descriptors, then returns a detached, deeply frozen JSON-safe
clone; it never returns an untrusted input object or proxy. There is no
payload-size limit in this first API; put large payloads in external storage
and persist a reference instead.

Standard Schema is structural and has no validator dependency. A transformed
schema whose output is not JSON-safe must provide an explicit encoder; no
`Date` or class serialization is inferred:

```ts
import { Result } from 'better-result'

const dateCodec = Codec.standardSchema({
  schema: DateFromIsoSchema,
  encode: (date) => Result.ok(date.toISOString())
})
```

Codec failures contain only bounded safe diagnostics, sanitized JSON-safe
paths/codes, and no payload, stack, arbitrary cause, or validator message that
could echo a secret. Codec identity belongs to a Job’s `name + version`; change
a codec without a version change only for a documented backward-compatible
wire change. Upcasters, registries, and persisted job definitions are outside
this issue’s scope.

## Queue and versioned Job definitions

The primary definition API is `Queue.define(...).job(...)`. It creates an inert,
immutable descriptor; it does not create a worker, resolve a Service, open a
connection, or register anything globally. The persisted identity is exactly the
literal queue, job name, and positive integer version. Function and class names
never participate in identity.

At definition time, a codec's `encode` and `decode` methods are captured with a
new frozen receiver. For a user-supplied structural or class codec, the Job
boundary clones and freezes the supported string-keyed own/prototype data graph,
including ordinary prototype helpers, without retaining the source receiver or
prototype graph. Receiver state must use finite primitives, `null`, `undefined`,
or recursively plain records and arrays; callable state other than
`encode`/`decode`, accessors, symbols, proxies, class instances, cycles, and
oversized or unreadable graphs are rejected as `JobDefinitionError`.

Codec operations themselves remain direct functions. Their lexical closures and
default-parameter expressions therefore keep normal JavaScript behavior. Job
does not clone external closure state; callers must treat captured state as
callback behavior, not descriptor data. A later mutation of captured application
state may consequently affect codec results, while mutation of the source
receiver's supported fields or prototype helpers cannot. Methods containing
`super`, private names/brands, direct `eval(...)`, or `new.target`, methods with
non-intrinsic mutable properties, and methods whose source cannot be inspected are rejected
because their receiver semantics cannot be safely detached. This is a narrow
receiver-safety check, not a free-variable or closure restriction.

The package's `Codec.*` constructors provide an operation-level contract without
a user receiver and use a private process-local capability. Values from another
package copy and all structural codecs still take the receiver-validation route;
a forgeable global marker cannot bypass it. Use a portable `Codec.*` codec or a
structurally safe class when receiver state is needed.

```ts
import { Codec, Job, JobRegistry, Queue, Retry, makePersistedBackoff } from 'better-effect-mq'

const Emails = Queue.define('emails')
const payload = Codec.json<{
  readonly messageId: string
  readonly tenantId: string
  readonly recipient: string
}>()
const failure = Codec.json<{ readonly code: string }>()
const backoff = makePersistedBackoff({
  type: 'exponential',
  delayMs: 1_000,
  maxDelayMs: 60_000
}).unwrap()

const SendEmailV1 = Emails.job('send-email', {
  version: 1,
  payload,
  failure,
  defaults: { attempts: 5, backoff, timeoutMs: 30_000, priority: 0 },
  idempotencyKey: ({ messageId }) => messageId,
  metadata: ({ tenantId }) => ({ tenantId }),
  retryable: ({ code }) => code !== 'recipient-blocked'
})
const SendEmailV2 = Job.define('send-email', {
  queue: Emails,
  version: 2,
  payload,
  failure
})

const Jobs = JobRegistry.make([SendEmailV1, SendEmailV2] as const)
Jobs.acceptedClaimIdentities // both versions, in definition order
Jobs.lookup({ queue: 'emails', name: 'send-email', version: 1 }) // Result<..., JobDefinitionError>
```

`retryable` is a synchronous definition-layer predicate. When a worker-side
caller evaluates it through `runRetryable`, a thrown predicate is deliberately
fail-open and becomes `true` (retryable) without retaining the thrown error or
failure payload. An untyped rejected Promise is also observed and normalized to
`true`; Promise results are not awaited. Non-boolean, non-Promise results remain
invalid predicate results.

`Job.define` is optional direct-call sugar over the same `Queue.job` implementation;
`Queue.define(...).job(...)` is the documented ergonomic form. `Job.PayloadInput`
is `Codec.Input` (the schema/input side), while `Job.Payload` is `Codec.Value`
(the decoded handler value). Idempotency and metadata callbacks receive
`Job.Payload`, and are not called while defining a job. Their later producer-side
outputs can be safely normalized with `normalizeIdempotencyKey` and
`normalizeMetadata`; invalid or throwing callbacks become a redacted
`JobDefinitionError` rather than exposing payload details.

`defaults.attempts` is a positive safe integer, `defaults.timeoutMs` is an
optional positive finite safe-integer millisecond duration, `priority` defaults
to the safe integer `0`, and `backoff` uses the existing `PersistedBackoff`
shape. Retention fields such as `keep` and `retain` are intentionally not part of
this v0.1 descriptor. Result and failure codecs are optional; when absent,
the corresponding `Job.Success` or `Job.Failure` type is `never`, and this
package performs no result persistence. Worker execution is provided separately
through the explicit Runtime boundary documented below.

`Job.is` and `Queue.is` use stable `Symbol.for` TypeIds and bounded, accessor-free
checks, so descriptors from duplicate package copies can be recognized safely.
The registry is local and immutable: duplicate queue/name/version identities are
rejected, unknown lookups return an explicit error Result, and no handlers are
registered. Enqueue, storage, retry scheduling, and worker execution remain
separate features.

## Producer and admin programs

A Job descriptor is also an immutable, typed producer. Its methods yield
`better-effect` programs and route every request through the descriptor's
`JobStore` token; they do not create a Runtime or know a storage adapter.
Enqueue validates/materializes its `Job.PayloadInput` with the payload codec,
then encodes it; metadata and idempotency callbacks run for each item and the
method returns a branded `JobId`:

```ts
import { ClockLive } from 'better-effect/standard-services'
import { Effect, Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { Codec, JobAdmin, MemoryJobStore } from 'better-effect-mq'

const SendEmail = Emails.job('send-email', {
  version: 1,
  payload: Codec.json<{ readonly to: string }>(),
  result: Codec.string
})

const runtime = await Runtime.make(Layer.merge(MemoryJobStore.layer, ClockLive))
const program = Effect.gen(async function* () {
  const id = yield* SendEmail.enqueue({ to: 'ada@example.test' })
  const snapshot = yield* SendEmail.poll(id)
  const counts = yield* JobAdmin.for(SendEmail.store).counts('emails')
  return Result.ok({ id, snapshot, counts })
})
await runtime.run(() => program)
```

The producer surface includes `enqueue`, `enqueueMany`, `poll`, `attempts`,
`awaitResult`, and `execute`. `delayMs` and `at` are mutually exclusive;
`execute` is only enqueue followed by polling and is not exactly-once RPC. A
caller aborting `awaitResult` stops waiting but does not cancel an already
persisted Job. `awaitResult` uses `Clock.sleep` and `CurrentAbortSignal`, and
returns typed handler failures separately from persisted defect, timeout,
decode, cancellation, not-found, identity-mismatch, and store errors.

Generic inspection and queue mutations require explicit routing:
`JobAdmin.for(store).list`, `.counts`, `.pause`, `.resume`, `.pausedQueues`, and
`.remove`. Job-bound `cancel`, `promote`, and `retry` verify the persisted
queue/name/version before mutating it. `retry` reuses the same Job ID and
preserves the attempt ledger; retrying by creating a new Job is not part of
this protocol version. Listing is encoded-neutral and
never guesses a codec for heterogeneous Jobs. `enqueueMany` accepts either a
payload array or `{ payload, options? }` entries when one item needs its own
ID, idempotency key, or schedule. It processes bounded chunks in input order;
a store failure after an earlier chunk is applied can therefore be partially
applied. Deterministic IDs or idempotency keys make safe replay possible.

## JobStore Service contract

`JobStore` is the only storage seam in this package. It is a yieldable
`better-effect` Service, not a CRUD repository, query builder, SQL abstraction,
or worker. An adapter supplies a structural `JobStore.Contract` through a Layer;
the core never imports a driver or inspects a backend kind.

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { Codec, JobStore, Queue } from 'better-effect-mq'

const DurableStore = JobStore.named('durable')
const Emails = Queue.define('emails')
const SendEmail = Emails.job('send', {
  version: 1,
  payload: Codec.json<{ readonly to: string }>(),
  store: DurableStore
})

const layer = Layer.succeed(DurableStore, DurableStore.of(adapterContract))
const program = () =>
  Effect.gen(async function* () {
    const store = yield* DurableStore
    return Result.ok(store.capabilities)
  })

await Runtime.run(layer, program)
```

The default token is `JobStore` (tag `@better-effect/mq/JobStore`). Named tokens
are lightweight handles identified by their complete literal tag,
`@better-effect/mq/JobStore/<name>`. Repeated calls for one name have compatible
types and tags but are not referentially cached; keep a token value when
referential equality matters. This avoids a process-global name registry and
allows multiple stores to be provided in one Runtime without resolving the
wrong store. A Job defaults to `JobStore`; pass `store` in its definition or
use `bindJob(job, DurableStore)` / `Job.bind` to select a named token. The
binding is immutable and does not register the Job or create a provider.

Every operation returns a `JobStoreOperation<Success, Failure>`: a completed
`better-effect` Result facade or a `PromiseLike` of one. Adapters may therefore
perform asynchronous I/O without changing the consumer boundary; await the
operation and feed it to `Result.await` inside an Effect generator. Each method
uses its own focused failure union, while `JobStoreError` remains the aggregate
compatibility alias.

A store implements these atomic operations:

- `enqueue` and `enqueueMany`: explicit or idempotency-derived uniqueness is a
  no-op reported as `{ duplicate: true }`; due jobs are waiting and future jobs
  are delayed. Batch results retain input order. Batch units are independently
  replayable rather than an all-or-nothing application transaction.
- `claim`: atomically promotes due delayed jobs, orders candidates, reserves at
  most `limit`, creates exclusive fencing leases, increments delivery counts,
  and returns active snapshots. `ClaimRequestFor<Registry>` narrows accepted
  versions to a local immutable `JobRegistry`.
- `settle`: validates the lease, records one attempt, clears the lease, and
  applies `complete`, `retry`, `fail`, or `cancelled` as one transition.
- `release`, `heartbeat`, and `recoverStalled`: release returns a job to
  waiting without consuming an attempt; heartbeat reports every lost lease and
  cancellation request; stalled recovery never takes a still-valid lease and
  persists requeue/fail plus its ledger entry atomically.
- `awaitWake`: waits for a version/token change for the selected queues. It may
  resolve spuriously, but the token prevents a wake between an empty claim and
  waiting from being lost. Aborting the signal returns
  `JobStoreWakeAbortedError`; polling-only stores may wait until abort because a
  worker also uses a timeout.
- `getJob`, `getAttempts`, `list`, and `counts` provide inspection. `list` supports
  optional queue, name, version, exact metadata, and state filters, plus
  `orderBy: 'enqueuedAt' | 'runAt' | 'finishedAt'`, `order: 'asc' | 'desc'`,
  and a limit. Its self-contained keyset cursor carries the primary value,
  `(orderingSequence, id)` tie-break, ordering, direction, and normalized filter
  binding; reuse with incompatible options is rejected.
- `retry`, `cancel`, `requestCancellation`, `promote`, `remove`, `pause`,
  `resume`, and `pausedQueues` provide the small administrative surface.
  Unsupported filter combinations return `UnsupportedJobStoreOperationError`;
  they never silently trigger a full scan.

The portable inspection support matrix is intentionally fixed:

| Operation               | Supported filters/order                                                                               | Cursor                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------- |
| `getJob`, `getAttempts` | one `jobId`                                                                                           | none                   |
| `list`                  | optional `queue`, `name`, `version`, exact `metadata`, one state or state list, and `orderBy`/`order` | optional keyset cursor |
| `counts`                | optional `queue` and `name`; returns every state bucket                                               | none                   |
| `pausedQueues`          | no filter                                                                                             | none                   |

There is no arbitrary predicate, offset pagination, provider-specific sort, or
implicit full scan in this contract. An adapter that cannot implement one of
the listed shapes returns `UnsupportedJobStoreOperationError` explicitly.

An enqueue may supply an explicit `jobId`, an `idempotencyKey`, or neither;
the store then derives a deterministic key or generates an ID according to its
adapter policy. Uniqueness is scoped by store, queue, and Job identity
(name/version), and a key collision is an observable duplicate rather than a
second job. ID/token collisions must be bounded and reported as
`JobStoreFailure`, never handled by an unbounded retry loop.

Every operation receives an explicit `now` where time affects state. A
`JobStoreFailure` describes infrastructure failure and state-specific tagged
errors describe invalid transitions or lost fencing leases. Store capabilities
(`notifications`, `queueFilteredNotifications`, `batchClaim`, `transactionalEnqueue`,
and `changeFeed`) are immutable performance hints: false never changes
correctness or makes a basic operation unavailable. The
`queueFilteredNotifications` flag declares the stronger guarantee that an
`awaitWake` waiter is not woken by an unrelated queue. Wake semantics remain on
`JobStore` rather than a separate notifier so token/version consistency cannot
be split across Services.

Adapters still own persistence and backend-specific behavior; the Worker only
consumes the public `JobStore.Contract`.

## Worker supervisor

`Worker` runs handlers over an already configured `better-effect` `Runtime`.
The application owns the Runtime and its Layer resources; the Worker never
configures global Service state, creates a parallel container, or exposes a
`Worker.layer`. An explicit Runtime handle is required so every store operation
and every handler attempt uses the same environment and lifecycle boundary.

```ts
import { CurrentAbortSignal, Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { JobContext, Worker } from 'better-effect-mq'

const SendEmailHandler = Worker.handle(SendEmail, (payload) =>
  Effect.fn(async function* () {
    const mailer = yield* Mailer
    const context = yield* JobContext
    const signal = yield* CurrentAbortSignal
    const sent = yield* Result.await(
      mailer.send(payload, { idempotencyKey: context.jobId, signal })
    )
    return Result.ok(sent)
  })
)

await using runtime = await Runtime.make(AppLive)
await using worker = await Worker.start(runtime, {
  handlers: [SendEmailHandler],
  concurrency: 8
})

await worker.awaitIdle()
```

`WorkerHandle.awaitIdle()` validates its timeout and AbortSignal before it
registers a waiter. Invalid options throw `WorkerAwaitIdleError`; an abort or
timeout rejects with the same focused error, and completed waits remove their
listeners and timers immediately.

`Worker.handle` receives the decoded Job payload and returns an
`Effect.Program<Success, Failure, Requirements>`. Its requirements are checked
against the Runtime at `Worker.start`: `JobContext` is supplied per attempt and
removed from the external requirement set, while the handler's root Services
and the Job's bound `JobStore` must be provided by the Runtime. Handler
registration and the returned inspectable handle are immutable.

Each claimed Job runs through `runtime.runWith(JobContext.layer(context), ...)`
with a fresh child Scope and attempt-local `AbortSignal`. Root Services remain
shared, but contexts and Scope finalizers do not leak between overlapping
attempts. A nominal `Result.err` becomes a typed failed settlement; a thrown or
rejected handler becomes a defect settlement. Result and failure values are
encoded through the Job's codecs before persistence.

Claims are grouped by store and queue. The supervisor reserves only currently
available slots, and the claim `limit` never exceeds the global concurrency,
queue cap, or the sum of available handler caps. The most restrictive of
`concurrency`, `queueConcurrency`, and a handler's `concurrency` applies. Empty
claims use `awaitWake` plus the poll interval and are interruptible by shutdown.
Every claim has a Worker-owned generation lease. If timeout or shutdown wins but
an adapter later returns active snapshots, the Worker never dispatches them and
best-effort releases each snapshot through the exact resolved store client and
lease token, with a bounded operation timeout. Adapters without cancellation may
mutate briefly before compensation runs; fencing and eventual lease expiry remain
the last resort. Claim, heartbeat, settlement, release, and stalled-recovery calls retry only
`JobStoreFailure` values marked `retryable`, with at most three retries and
cancelable bounded backoff. Lease/state/not-found errors are never retried as
infrastructure failures. A handler error is reported through `onError` and does
not terminate other claim loops.

Use `Worker.use` when one owner should always stop the supervisor:

```ts
await Worker.use(runtime, { handlers: [SendEmailHandler] }, async (worker) => {
  await worker.awaitIdle()
})
```

`WorkerHandle.stop()` is idempotent; it marks the Worker as stopping before
aborting claim waits, prevents new claims, waits for active attempts according
to the selected policy, and removes its local timers/listeners. Pass
`{ abortActive: true }` to cooperatively signal active attempts. The handle also
implements `Symbol.asyncDispose`.

Workers for named `JobStore` tokens can share one Runtime, while each store
continues to receive only the Jobs bound to its token.

### Reliability and shutdown

`WorkerReliabilityOptions` adds lease supervision without changing the handler
API. `leaseDurationMs` defaults to 30 seconds, `heartbeatIntervalMs` to one
third of the lease, `stalledIntervalMs` to the lease, `maxStalledCount` to one,
and `pollIntervalMs` to 100ms (a zero poll value is clamped to 1ms).
Durations must be finite positive safe integers. `leaseDurationMs` must be at
least 10ms, `stalledIntervalMs` at least 10ms, and heartbeat must be shorter
than the lease. `maxStalledCount`
is a non-negative integer. `shutdown.gracePeriodMs`
defaults to zero and `abortAfterGracePeriod` defaults to false. Top-level
options override these defaults; malformed options are rejected before any
claim or supervision loop starts.

Heartbeats are batched independently per store. Lost leases abort the attempt
cooperatively with `LeaseLostError`; a late handler result is discarded and
cannot settle with the stale token. Active cancellation is likewise cooperative:
the worker waits for the child Scope and then records `cancelled`. A Promise that
ignores its signal cannot be killed; external side effects must therefore be
idempotent and fenced with the job ID or an application idempotency key.

Expired leases are recovered through the public `recoverStalled` operation. The
store's atomic transition and stalled ledger are the source of truth, so late
completion is fenced. If a settlement response is lost after the store may
have applied it, the worker retries infrastructure failures with bounded
exponential backoff using
the exact same job ID and lease token. The persisted terminal record is the
source of truth: stores that can prove same-token application return a typed
`{ status: 'already-applied' }` acknowledgment without a second ledger entry;
first applications return `{ status: 'applied' }`. Otherwise they must return
`LeaseLost`/an infrastructure failure and the worker reports the uncertainty
without manufacturing another handler attempt.

`WorkerHandle.stop()` transitions to stopping before awaiting anything, stops new
claims, keeps supervision active for in-flight attempts, applies the configured
grace period, and cleans its waits and supervision timers. `Worker.use` always
stops the Worker before returning. When using a long-lived Runtime, the owner
must use the order `await worker.stop(); await runtime.dispose()`; disposal of
the Runtime first can reject Worker store calls and only permits best-effort
convergence. There is no exactly-once guarantee.

A handler error is reported through `onError` and does not terminate other claim
loops.

## Process-local observability

`JobEvent` and `JobObserver` provide storage-neutral, process-local telemetry
without adding an OpenTelemetry, Prometheus, or logger dependency. Attach one
observer to a Worker, or compose several adapters in declaration order:

```ts
const observer = JobObserver.compose(
  JobObserver.logger((event) => console.info(event.message, event.data)),
  JobObserver.metrics(metricsSink)
)

await using worker = await Worker.start(runtime, {
  handlers: [SendEmailHandler],
  observer
})
```

Observer callbacks are synchronous from the Worker’s perspective and are never
awaited. A throw or rejected thenable is contained and does not affect queue
claims, settlement, leases, or shutdown. Keep callbacks short and offload slow
work to an external bounded system; the package does not create an unbounded
internal observer queue. Events are shallow-frozen snapshots and contain only
scalar/brand identity, timing, transition, and bounded failure-kind/code fields.
They never include payloads, results, metadata, idempotency keys, lease tokens,
causes, messages, or failure data.

`Job.observe(job, observer)` attaches producer/admin store-operation and
administrative transition events to an immutable Job descriptor. For generic
inspection operations use `JobAdmin.observe(observer).for(store)`. Worker
lifecycle events are attached independently through `WorkerOptions.observer`.
`RecordedJobObserver` is available from `better-effect-mq/testing`:

```ts
const recorded = RecordedJobObserver.make()
const observedJob = Job.observe(SendEmail, recorded)
recorded.events // readonly event timeline
recorded.snapshot() // detached readonly view
recorded.clear()
```

The optional logger adapter accepts a callback, a `{ log }` object, or levelled
`debug`/`info`/`warn`/`error` methods. When no target is supplied, it writes to
`console`; its defaults log retries and terminal
failures at `warn`/`error`, lease/stall events at `warn`, and startup/shutdown at
`info`; successful runs are omitted unless enabled. `JobObserver.metrics(sink)`
uses stable names such as `better_effect_mq_job_runs_total` and
`better_effect_mq_jobs_in_flight`. Metric labels use only queue/name and bounded
outcome fields—never job or worker IDs.

Queue depth is an opt-in gauge sampler over `JobStore.counts`:

```ts
const sampler = JobObserver.depthSampler(store, metricsSink, {
  queues: [queueName],
  intervalMs: 1_000
})
sampler.start()
// sampler.stop() cancels future samples and timers
```

The first sample is immediate, later samples wait for the configured interval,
and stopping the sampler ignores an in-flight result. Depth is `waiting +
delayed` and is emitted as `better_effect_mq_queue_depth` with only a `queue`
attribute.

Worker handler attempts are also named for Runtime observers as
`better-effect-mq/<queue>/<job>@<version>` with the allowlisted `mq.*`
attributes (`mq.job.id`, `mq.job.name`, `mq.job.version`, `mq.job.queue`,
`mq.job.attempt`, and `mq.worker.id`). Runtime remains the owner of execution
start/end events; MQ does not duplicate them. A completed/retry/failure event is
emitted only after its settlement is confirmed, and an uncertain settlement
emits a store-operation failure rather than a false completion.

## MemoryJobStore reference driver

`MemoryJobStore` is the complete in-process reference driver for tests, demos,
and disposable processes. Every call creates a fresh isolated store; it keeps
all protocol state in memory and is not durable, shared across processes, or a
distributed coordination mechanism. Restarting the process loses every job,
lease, attempt, pause, and wake version.

```ts
import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { JobStore, MemoryJobStore } from 'better-effect-mq'

const runtime = await Runtime.make(MemoryJobStore.layer)
const result = await runtime.run(() =>
  Effect.gen(async function* () {
    const store = yield* JobStore
    return Result.ok(store.capabilities)
  })
)
await runtime.dispose()
```

Use `MemoryJobStore.layerWith({ clock, idGenerator })` or
`MemoryJobStore.make({ clock, idGenerator })` when a deterministic
`Clock`/`IdGenerator` test double is useful. `MemoryJobStore.layerFor(token,
options)` provides the same reference semantics under a named `JobStore` token.
The driver uses the same ordering, fencing, settlement, ledger, admin,
listing, cursor, and wake behavior as the storage-neutral contract, but makes
no persistence or cross-instance visibility guarantees.

## TestJobStore utility

`better-effect-mq/testing` also provides `TestJobStore`, a small harness that
keeps one `MemoryJobStore` instance together with a controllable clock, ID
source, Layer, and `RecordedJobObserver`. Its inspection helpers use the public
store contract and the exact Job codec; they never mutate private store state.

```ts
import { Effect } from 'better-effect'
import { ClockTest, IdGeneratorTest } from 'better-effect/standard-services'
import { TestRuntime } from 'better-effect/testing'
import { Result } from 'better-result'
import { Codec, Queue } from 'better-effect-mq'
import { TestJobStore } from 'better-effect-mq/testing'

const SendEmail = Queue.define('emails').job('send-email', {
  version: 1,
  payload: Codec.json<{ readonly to: string }>()
})
const testStore = TestJobStore.make({
  clock: new ClockTest(Date.UTC(2026, 0, 1)),
  ids: IdGeneratorTest.from((index) => `job-${index + 1}`)
})
const observedSendEmail = testStore.observe(SendEmail)
const runtime = await TestRuntime.make(testStore.layer, {
  clock: testStore.clock,
  idGenerator: testStore.idGenerator
})

const jobId = await runtime.run(() =>
  Effect.gen(async function* () {
    const id = yield* observedSendEmail.enqueue({ to: 'ada@example.test' })
    return Result.ok(id)
  })
)
if (Result.isError(jobId)) throw jobId.error

const records = await testStore.enqueued(SendEmail)
const payloads = await testStore.enqueuedPayloads(SendEmail)
const attempts = await testStore.attempts(jobId.value)
void records
void payloads
void attempts
await runtime.dispose()
```

`TestJobStore.makeFor(namedStore, options)` creates the same harness for a named
`JobStore` token. `claim`, `settle`, and `release` accept the explicit public
lease/token requests, so tests can exercise fencing and attempt-ledger
transitions without a fake reducer. Use the real `Worker` for worker scenarios;
the harness does not implement a second supervisor.

## Runner-agnostic JobStore conformance

The `better-effect-mq/testing` entrypoint publishes stable JobStore scenarios,
without importing Bun, Vitest, Jest, or any other test runner. The adapter owns
the runtime and storage setup:

```ts
import { Runtime } from 'better-effect'
import { jobStoreContract } from 'better-effect-mq/testing'
import type { JobStoreContractRuntime } from 'better-effect-mq/testing'

const scenarios = jobStoreContract({
  makeRuntime: async (context) => {
    const runtime = await Runtime.make(
      MyStore.layer({
        database: databaseFor(context.id)
      })
    )

    const adapter: JobStoreContractRuntime<InstanceType<typeof context.token>> = {
      run: (program, options) => runtime.run(program, options),
      dispose: () => runtime.dispose()
    }
    return adapter
  },
  setup: async (context) => createSchema(context.id),
  reset: async (context) => resetDatabase(context.id),
  capabilities: {
    notifications: true,
    queueFilteredNotifications: true,
    batchClaim: true
  }
})
```

Register the same scenarios with any runner. For Bun:

```ts
import { test } from 'bun:test'

for (const scenario of scenarios) {
  test(scenario.name, scenario.run)
}
```

For Vitest:

```ts
import { describe, it } from 'vitest'

describe('MyStore JobStore contract', () => {
  for (const scenario of scenarios) {
    it(scenario.name, scenario.run)
  }
})
```

Each scenario gets fresh controls, runs `setup`, then creates its runtime, and
always disposes every runtime opened by the scenario (including extension
clients) before `reset`.
Cleanup is attempted after assertion failures, and the primary scenario error
is preserved when cleanup also fails. `makeRuntime` is the normal
adapter-specific hook; the optional `makeMultiStoreRuntime` adds the named-store
scenario. The kit uses the public `JobStore.Contract` surface and never accesses
tables, keys, drivers, or private adapter methods.

Built-in scenarios cover enqueue identity and independent batch replay,
ordering and atomic claims, leases/fencing/stalls, settlement ledgers,
administration, keyset listing, controlled time, and wake-up abort/token
semantics. `capabilities` is immutable metadata: false never skips a basic
correctness scenario. Optional notification and batch-claim scenarios are
returned only when their capability is declared; unsupported scenarios appear
in `suite.report().skipped`. The report also includes `executed`, `passed`,
`failed`, and `capabilitiesNotTested` so CI can make capability coverage
explicit.

The context exposes a deterministic `clock`, `ids`, `barrier`, and checkpoint
hooks for distributed or crash extensions. Notification adapters may use the
runner-neutral `synchronization` handshake: call `ready()` after installing an
`awaitWake` waiter, call `observed()` after checking the token/event, and use
`waitForDelivery()`/`release()` to make the lost-wake boundary explicit. The kit
resets this handshake during cleanup, so tests do not need timers or Promise-turn
assumptions. Supply a controls factory when each scenario needs separate state.
Extensions can call `openClient()` to obtain a second runtime over the same
adapter storage. A `makeMultiStoreRuntime` option can additionally provide the
default store plus the fixed `contract-store-a` and `contract-store-b` named
tokens in one Runtime; extensions can inspect the same arrangement through
`openMultiStore()`. The kit does not provision Testcontainers or require real
sleeps. Unsupported list shapes must return
`UnsupportedJobStoreOperationError` according to the fixed support matrix above.

## State machine

The only v0.1 states are `waiting`, `delayed`, `active`, `completed`, `failed`,
and `cancelled`.

```text
                         claim (when due)
                 +------------------------------+
                 |                              v
             +---------+     claim          +--------+
             | delayed | -----------------> | active |
             +---------+                    +--------+
                 ^                           |  |  |  |
                 | retry (future)             |  |  |  +-- fenced Cancelled --> cancelled
                 |                           |  |  +----- fenced Fail -------> failed
             +---------+ <------------------+  +--------+
             | waiting |  retry (due) / release   |
             +---------+                          +-- fenced Complete --> completed
                 |  ^                              |
                 |  | admin cancel                 +-- expired recoverStalled --> waiting (or terminal failed/cancelled at counter edge)
                 +-> cancelled

             failed/cancelled -- explicit admin retry --> waiting or delayed
```

A claim promotes a due delayed job directly to `active`; there is no public
`delayed -> waiting` mutation in the claim path. Legal transition preconditions
are:

- `waiting` is claimable when its `runAt` is due; `delayed` is claimable only
  when `runAt <= now`.
- Claim supplies a new non-empty lease token, worker ID, and an expiry strictly
  later than `now`.
- `promote` is a separate explicit administrative schedule override for a
  `delayed` job. It is allowed even when the original `runAt` is in the future,
  sets `runAt` to `now`, and moves the job to `waiting` without claiming it or
  changing its attempt/delivery counters. It emits no attempt ledger entry;
  ordinary claim still requires the delayed job's `runAt` to be due.
- Every transition leaving `active` (`complete`, `retry`, `fail`, `cancelled`,
  and `release`) requires the exact current lease token and `now < leaseExpiresAt`.
  Missing, old, or expired tokens return `LeaseLostError` and leave the snapshot
  unchanged.
- `recover-stalled` is the administrative, unfenced path for an active lease
  whose expiry is reached. Every recovery increments `stalledCount`, saturating
  at its non-negative safe integer maximum. When the current count has reached
  the store's configured `maxStalledCount` policy, that same recovery
  terminalizes instead of requeueing and still persists the incremented count;
  callers cannot force this policy through the protocol command. A pending
  cancellation terminalizes as `cancelled` with a `cancelled` ledger entry;
  otherwise the job terminalizes as `failed` with a non-retryable `stalled`
  failure and one `stalled` ledger entry. `failed` is the resulting
  `JobRecord.state`, while `stalled` is the ledger outcome: no handler returned
  `failed`, and `attemptsMade` is unchanged. It never wraps the counter or
  leaves a saturated active job waiting forever.
- Cancelling an active job first records a cancellation request while retaining
  its lease. It does not steal the lease. The next active exit is deterministically
  terminal: a `settle` (including complete, retry, fail, or cancelled) becomes
  `cancelled`, and release or stalled recovery becomes `cancelled` instead of
  requeueing the job. A worker must use the current token for a handler
  settlement. A requested cancellation observed by stalled recovery increments
  `stalledCount` while possible and preserves a saturated count at the numeric
  maximum; the cancellation ledger entry does not consume an attempt because no
  handler settled. Waiting and delayed jobs can be cancelled
  by an administrative cancel command.
- `completed`, `failed`, and `cancelled` are terminal. They never silently
  revive. `retry` is the explicit administrative transition for a failed or
  cancelled job; it preserves delivery and attempt history in the external
  attempt ledger. If the retry budget was exhausted, retry starts a fresh
  budget; otherwise it preserves the current attempt counter.
- Future states such as `waiting-children` require a protocol revision.

The reducer is pure and immutable. `reduceJob` returns the new record and, when
appropriate, the `AttemptRecord` that an adapter should persist atomically with
it. Storage adapters own the transaction; this package does not implement one.

## Attempts, deliveries, and stalls

These counters are intentionally different, and all use safe integer
representations:

- Every `JobRecord` satisfies `attemptsMade <= deliveryCount`. An `active`
  record additionally requires `deliveryCount >= 1` and
  `attemptsMade < deliveryCount`, representing a claim that has not settled.
- `attemptsMax` is a positive safe integer. `attemptsMade` counts handler
  executions that settle as `completed`, `retried`, `failed`, or `cancelled`,
  and is compared with `attemptsMax`. `waiting`, `delayed`, and `active` records
  must have `attemptsMade < attemptsMax`, reserving one safe execution-counter
  slot before a job can be claimed. A handler `cancelled` settlement increments
  `attemptsMade` exactly once, including when that slot reaches `attemptsMax`;
  it never overflows or creates an `attemptsMax + 1` record. Release during
  shutdown and stalled recovery do not consume this retry budget. A record at
  the budget edge must be terminal or explicitly retried before it can run
  again.
- `deliveryCount` counts every successful claim/reservation, including
  redelivery after a release or stalled recovery. A claim at its safe-integer
  maximum is rejected rather than wrapping.
- `stalledCount` counts recoveries of expired active leases, including a recovery
  that terminalizes a pending cancellation. It increments while possible and
  saturates at its safe-integer maximum; the saturated recovery behavior is
  defined above.

`AttemptRecord.attempt` and `.delivery` preserve those meanings, and every
ledger entry satisfies `attempt <= delivery`. `released` and `stalled` entries
remain visible even when no handler returned an outcome; a
cancellation terminalized by release or stalled recovery uses the current
attempt number and records a `cancelled` entry. In particular, saturated stalled
recovery pairs a terminal `failed` JobRecord with a `stalled` ledger outcome; the
state and ledger outcome are distinct and adapters must not treat that event as a
handler failure or consume an attempt.

## Ordering and time

Adapters must use the same total claim order:

1. higher `priority` first;
2. lower `runAt` first;
3. lower persisted `orderingSequence` first (stable insertion order);
4. compare the JobId UTF-8 byte sequences lexicographically as unsigned bytes:
   at the first differing byte, the lower byte sorts first; when one sequence is
   a prefix of the other, the shorter sequence sorts first. JobId validation
   rejects unpaired UTF-16 surrogates, so accepted IDs encode each Unicode scalar
   exactly with standard UTF-8; no replacement or canonicalization is performed.
   This is bytewise UTF-8 order, not JavaScript UTF-16 order or locale collation,
   and every adapter must reproduce it exactly.

All protocol timestamps and durations are validated before reaching a store.
Timestamps are non-negative safe integer epoch milliseconds. Durations are
non-negative safe integer milliseconds; lease expiry is separately required to
be strictly in the future. Protocol calculations receive one coherent `now`
from the configured clock. This package never calls `Date.now()` and adapters
must not silently mix application, SQL, Redis, or test clocks in one operation.

## Version policy

`protocolVersion = 1` is experimental but explicit. A breaking change to state
semantics, persisted field meaning, transition preconditions, ordering, or safe
failure representation requires a new protocol version, a changelog entry in
this package, and coordinated adapter updates. Backward-compatible additions
may be made within a version when existing records and adapters retain their
meaning. Future codecs and job definitions may carry their own `name + version`
identity, but they must not change this protocol silently.

## Installation

```bash
bun add better-effect-mq better-effect better-result
```

The package requires `better-effect` `>=0.13.0 <0.14.0` and
`better-result` `^3.0.0`. TypeScript `5.7` or newer is supported, together
with the Node.js and Bun runtime matrix used by this repository.

### Repository validation

Run `bun run check` from the repository root for the canonical package check.
Turbo builds the workspace `better-effect` dependency before this package
checks its public declarations, so the command is safe from a clean checkout.
A package-local `bun run check` does not orchestrate sibling workspace builds;
when running it directly, build the dependency first:

```bash
(cd ../better-effect && bun run build)
bun run check
```

## License

MIT
