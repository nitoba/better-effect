# better-effect-mq

Typed, storage-neutral building blocks for durable background work with
[`better-effect`](https://github.com/nitoba/better-effect) and
[`better-result`](https://github.com/nitoba/better-result).

`better-effect-mq` gives an application a small, composable vocabulary for
declaring jobs, enqueueing them, processing them with workers, and observing
their progress. The core package does not choose a database, queue server, or
dependency-injection container. A storage adapter implements the `JobStore`
contract and is provided through a `better-effect` `Layer`.

The result is a clean boundary:

```text
application code  →  Job / Worker / awaitResult
                         ↓
                 JobStore + optional JobEventStore
                         ↓
                 Memory or a durable adapter
```

## Install

```bash
bun add better-effect-mq better-effect better-result
```

The package expects `better-effect >=0.13`, `better-result ^3`, and TypeScript
6 or newer. Use the package's `npm` or `pnpm` equivalent if that is how your
application manages dependencies.

## Quick start: a complete in-memory queue

The following program defines a typed job, starts a Layer-owned worker, submits
one item, waits for its result, and disposes the Runtime. It is the same public
API shape exercised by the package's runnable examples; save it as an ESM
TypeScript file in a project with the dependencies above to run it.

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import { Codec, JobContext, JobStore, MemoryJobStore, Queue, Worker } from 'better-effect-mq'

const Emails = Queue.define('emails')
const SendEmail = Emails.job('send-email', {
  version: 1,
  payload: Codec.json<{
    readonly recipient: string
  }>(),
  result: Codec.string
})

const store = MemoryJobStore.make()
const handler = Worker.handle(SendEmail, (payload) =>
  Effect.fn(async function* () {
    const context = yield* JobContext
    console.log(`attempt ${context.attempt}: sending to ${payload.recipient}`)
    return Result.ok(`sent:${payload.recipient}`)
  })
)

const AppWorker = Worker.service('@app/EmailWorker')
const AppWorkerLive = AppWorker.layer(() => ({
  handlers: [handler] as const,
  concurrency: 1,
  pollIntervalMs: 10
}))

const AppLive = Layer.complete(
  Layer.merge(Layer.succeed(JobStore, JobStore.of(store)), Layer.merge(ClockLive, AppWorkerLive))
)

const runtime = await Runtime.make(AppLive)

try {
  const started = await runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* AppWorker)
    })
  )
  if (Result.isError(started)) throw started.error

  const completed = await runtime.run(() =>
    Effect.gen(async function* () {
      const jobId = yield* SendEmail.enqueue({
        recipient: 'ada@example.test'
      })
      const result = yield* SendEmail.awaitResult(jobId)
      return Result.ok({ jobId, result })
    })
  )
  if (Result.isError(completed)) throw completed.error

  console.log(completed.value)
  await started.value.awaitIdle()
} finally {
  await runtime.dispose()
}
```

What happened:

1. `Queue.define` created a queue namespace. Its `Job` descriptor is immutable
   and does not open a connection or register a handler.
2. `MemoryJobStore` supplied the storage implementation. `JobStore.of(store)`
   adapts that implementation to the `JobStore` Service token.
3. `Worker.handle` connected the typed payload to a `better-effect` program.
   `Worker.service(...).layer(...)` owns the worker's start and stop lifecycle.
4. `runtime.run` provided the Services and Scope needed by each operation.
   `awaitResult` used bounded polling because no event log was installed.

`MemoryJobStore` is deliberately isolated and process-local. It is ideal for a
quick start, unit tests, demos, and disposable processes; it is not a durable
queue and its state disappears on process restart.

## The pieces and how they fit

### `Queue` and `Job`: the application contract

A queue groups related jobs. A job gives one work type a stable queue/name/
version identity and declares the codecs used at the storage boundary:

```ts
import { Codec, Queue, Retry } from 'better-effect-mq'

const Billing = Queue.define('billing')

const ChargeCard = Billing.job('charge-card', {
  version: 1,
  payload: Codec.json<{
    readonly paymentId: string
    readonly amountCents: number
  }>(),
  result: Codec.json<{ readonly receiptId: string }>(),
  failure: Codec.json<{ readonly code: string }>(),
  defaults: {
    attempts: 3,
    backoff: Retry.exponential({
      initialDelayMs: 1_000,
      factor: 2,
      maxDelayMs: 60_000,
      maxAttempts: 3
    })
  },
  idempotencyKey: ({ paymentId }) => paymentId,
  retryable: ({ code }) => code !== 'card-declined'
})
```

The payload is the decoded value seen by the handler. The result and failure
codecs describe values that can be read back by producers and administrators.
`defaults` supplies retry and timeout policy; enqueue options can override the
per-item schedule. An idempotency key makes a replay of the same request
observable as a duplicate instead of creating another job.

The descriptor is inert: defining a job does not resolve a Service, create a
worker, or register anything globally. The same descriptor is used by
producers, workers, and inspection code, so a producer and a worker cannot
silently disagree about payload or result types.

### `JobStore`: the storage seam

`JobStore` is a yieldable Service, not a CRUD repository or a database client.
An adapter implements its storage-neutral contract and provides it through a
Layer. The contract covers the queue operations an adapter needs to make
atomic in its own storage system:

- enqueue one or many jobs, including duplicate/idempotency handling;
- claim due jobs and lease them to a worker;
- settle a lease as completed, retried, failed, or cancelled;
- heartbeat, release, and recover stalled leases;
- inspect jobs, attempt history, and queue counts;
- perform explicit administration such as retry, cancel, pause, resume, and
  remove; and
- wait for a queue wake-up when the backend can provide one.

The core only sees `JobStore.Contract`. It does not inspect a backend kind or
import a driver. Applications can use more than one store in one Runtime with
`JobStore.named('name')`; each Job can be bound to the store it belongs to.

### `Worker`: supervised execution

`Worker.handle(job, handler)` connects one Job to a typed handler program. A
handler receives the decoded payload and may yield application Services. During
an attempt it can also yield `JobContext` for the job ID, attempt number,
delivery count, metadata, and worker identity.

`Worker.service(tag)` returns a Layer-first Service. Its factory is acquired
lazily, and its Layer owns the worker lifecycle. A worker claims jobs,
executes handlers with an attempt-local cancellation signal and Scope, records
the outcome, and keeps processing other jobs when one handler fails.

Workers support bounded concurrency, queue and handler limits, retry policies,
timeouts, lease heartbeats, stalled recovery, and graceful stop. Use the
Runtime that owns the worker for the full application lifetime; on shutdown,
stop the worker before disposing that Runtime when you manage both explicitly.

### Producer operations

Every Job exposes typed operations that are yieldable inside an `Effect`
program:

| Operation                    | Use it for                                          |
| ---------------------------- | --------------------------------------------------- |
| `enqueue`                    | Submit one decoded payload and receive its `JobId`. |
| `enqueueMany`                | Submit a batch while retaining input order.         |
| `poll`                       | Read one job snapshot without waiting.              |
| `awaitResult`                | Wait for a terminal result or typed failure.        |
| `execute`                    | Enqueue and wait using one operation.               |
| `attempts`                   | Read the durable delivery ledger for one job.       |
| `cancel`, `retry`, `promote` | Apply explicit job administration.                  |

For heterogeneous queries, bind the store token explicitly with
`JobAdmin.for(JobStore).list(...)`, `.counts(...)`, `.pause(...)`, `.resume(...)`,
or `.remove(...)`.

## Choosing Memory or a durable adapter

`MemoryJobStore` and a durable adapter expose the same application-facing
`Job`, `JobStore`, and `Worker` shape. The choice is about operational
guarantees, not a different programming model.

|          | `MemoryJobStore`                                      | Durable adapter                                                                     |
| -------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| State    | One isolated in-process instance.                     | Stored in the adapter's persistent backend.                                         |
| Restart  | Jobs, leases, and attempts are lost.                  | State can be recovered after a process restart.                                     |
| Sharing  | Not a coordination mechanism between processes.       | Multiple producers/workers can share the configured backend.                        |
| Best for | Tests, examples, local development, short-lived work. | Production work that must survive crashes and be shared or resumed.                 |
| Setup    | `MemoryJobStore.make()` or `MemoryJobStore.layer`.    | The adapter package's Layer factory and its host-owned or adapter-owned connection. |

Start with Memory when you are validating application behavior or writing
tests. Move to a durable adapter when losing queued work on restart is not
acceptable, when workers run in more than one process, or when operations need
durable inspection and recovery. The application Job definitions and Worker
handlers stay the same; only the providers in the Runtime composition change.

The core package intentionally does not duplicate the setup instructions for
each backend. See the [composition guide](./docs/composition.md) for the
current Layer shape and adapter recipes, and the [driver author guide](./docs/writing-a-driver.md)
if you are implementing a new adapter.

## Adding a durable EventLog

`JobEventStore` is an optional event-log Service associated with a `JobStore`.
A durable implementation appends compact, safe transition facts such as
enqueue, claim, completion, retry, failure, cancellation, and queue changes.
Each event has an opaque cursor, so a consumer can resume from a checkpoint.
Retention is bounded by the adapter's configured policy; an expired cursor is
an explicit condition, not an infinite archive.

The EventLog is useful for feeds, dashboards, audit-shaped transition history,
and waking a caller that is waiting for a result. It is deliberately not a
copy of the Job record: payloads, results, complete failure data, metadata, and
lease tokens do not belong in event attributes by default.

### Memory EventLog composition

The in-process event store uses the same composition shape as a durable event
adapter. Pass the same instance to `MemoryJobStore.make({ eventStore })` so
committed Memory transitions append to the log, then provide both Services in
one Runtime:

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import { JobEventStore, JobStore, MemoryJobEventStore, MemoryJobStore } from 'better-effect-mq'

const events = MemoryJobEventStore.make({
  retention: { count: 1_000, ageMs: 24 * 60 * 60 * 1_000 }
})
const store = MemoryJobStore.make({ eventStore: events })

const AppLive = Layer.complete(
  Layer.merge(
    Layer.succeed(JobStore, JobStore.of(store)),
    Layer.merge(Layer.succeed(JobEventStore, JobEventStore.of(events)), ClockLive)
  )
)

const runtime = await Runtime.make(AppLive)
const tail = await events.tailCursor()
if (Result.isError(tail)) throw tail.error
await runtime.dispose()
```

`MemoryJobEventStore` is a reference implementation for tests and local
experiments; it is not durable across restarts. A durable adapter provides the
same `JobEventStore` token through its own Layer. Keep the JobStore and its
matching event store in the same Runtime rather than creating a second Runtime
just to read events.

### Waiting for a result with events

Polling is the default and does not require an EventLog. If the matching event
store is installed, opt into event-driven waiting and retain a bounded polling
fallback:

```ts
const result = await runtime.run(() =>
  Effect.gen(async function* () {
    const jobId = yield* SendEmail.enqueue({
      recipient: 'ada@example.test'
    })
    const value = yield* SendEmail.awaitResult(jobId, {
      strategy: 'events',
      eventStore: JobEventStore,
      pollFallbackMs: 5_000
    })
    return Result.ok({ jobId, value })
  })
)
```

`awaitResult` still rereads the Job record before decoding its result or
failure. An event is a wake hint, not the source of truth; if reading or
notifying events fails, bounded polling can continue. Aborting the wait stops
the caller's wait but does not cancel a Job already persisted in the store.

For a finite read, use `JobEvents.page(JobEventStore, options)`. For a
continuous sequential consumer, use `JobEvents.forEach(...)`; the caller owns
the cursor and should persist it only after the handler succeeds. Restarting
from the last persisted cursor gives at-least-once event delivery. The
consumer uses the active Runtime and Scope and does not create a subscriber or
a second Runtime.

For an independently managed long-lived event consumer, the Layer-first
`JobEventConsumer.service(...).layer(...)` API owns only the polling and
callback lifecycle. Cursor checkpoints remain application-owned. See the
[composition guide](./docs/composition.md) for the complete consumer example.

## EventLog, AttemptRecord, and local observers

These three surfaces answer different operational questions. They are
complementary, not interchangeable:

| Surface                                   | Answers                                                    | Lifetime and delivery                                                                                      | Data boundary                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `JobEventStore` (EventLog)                | “What committed transitions can a resumable feed consume?” | Durable when backed by a durable adapter; bounded retention; cursor-based and at-least-once for consumers. | Compact event facts and bounded attributes; no payload, result, complete failure body, or lease token by default. |
| `AttemptRecord` via `job.attempts(jobId)` | “What happened on each delivery of this Job?”              | Durable with the JobStore record; queryable history, not an append-only feed or cursor source.             | Detailed outcome, timing, retry schedule, and codec-decoded result/failure views; treat as potentially sensitive. |
| `JobObserver`                             | “What should this process log or measure right now?”       | Process-local and best-effort; callbacks are not awaited and may be lost on crash or shutdown.             | Storage-neutral event snapshots for logs and low-cardinality metrics; observers must not affect queue behavior.   |

Use the EventLog for replayable transition feeds and wake-ups, AttemptRecord
for per-delivery diagnosis, and `JobObserver` for local logs/metrics. Do not
promote an observer to a durability mechanism or copy sensitive Job data into
event attributes.

Attach an observer to a worker or Job without adding a logging dependency:

```ts
import { Job, JobObserver } from 'better-effect-mq'

const observer = JobObserver.logger((event) => {
  console.info(event.message, event.data)
})

const ObservedSendEmail = Job.observe(SendEmail, observer)
// Use ObservedSendEmail for producer/admin operations, or pass `observer`
// in a Worker service Layer for worker lifecycle and attempt events.
```

`JobObserver.compose(...)` combines observers in declaration order, and
`JobObserver.metrics(...)` adapts a metrics sink. Observer failures are
contained and never change claims, settlement, leases, or shutdown.

## Reliability guarantees and limits

- Delivery is **at least once**. A handler can perform an external side effect
  and crash before its settlement is stored, so external effects must be
  idempotent (usually with the Job ID or an application idempotency key).
- Leases and fencing prevent an old worker from settling a newer delivery.
  They cannot undo an external side effect that already happened.
- Typed handler failures can be retried according to `Retry` and the Job's
  `retryable` policy. Defects, codec failures, timeouts, and cancellations are
  represented separately so operators can distinguish them.
- A successful settlement records the Job outcome and an attempt ledger entry.
  If a settlement response is lost after the backend applied it, a retry can
  acknowledge the already-applied outcome without creating a second attempt.
- Worker shutdown is cooperative. The Runtime stops admitting new work,
  allows active attempts to settle according to its configured policy, and
  closes owned resources. A Promise that ignores its cancellation signal
  cannot be forcibly killed.
- Event retention is bounded. A cursor can expire, and an EventLog is not an
  infinite archive or a replacement for payload/result storage.
- The package does not promise exactly-once execution or a transaction spanning
  a JobStore and an external API. Use an idempotency key, an outbox, or a
  backend-specific transaction integration when your workflow needs one.

## Testing and adapter references

The `better-effect-mq/testing` entrypoint provides `TestJobStore`,
`RecordedJobObserver`, and runner-neutral conformance suites for JobStore,
EventLog, flow, and schedule adapters. The package's examples can be checked
with:

```bash
bun run typecheck:examples
bun run test:examples
```

The [examples README](./examples/README.md) describes each runnable example.
For advanced implementation details, use the [composition guide](./docs/composition.md),
the [driver author guide](./docs/writing-a-driver.md), and the
[protocol reference](./docs/protocol/). Those documents are primarily for
adapter authors and maintainers; application code should normally stay on the
public `Job`, `Worker`, `JobStore`, and `JobEventStore` APIs described here.
