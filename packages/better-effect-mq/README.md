# better-effect-mq

Typed, storage-neutral building blocks for durable background work with
[`better-effect`](https://github.com/nitoba/better-effect) and
[`better-result`](https://github.com/nitoba/better-result).

The core package gives applications one vocabulary for defining jobs,
enqueueing work, running workers, coordinating parent/child executions, and
reading results. It does not choose a database, queue server, or dependency
injection container. A storage adapter implements the `JobStore` contract and
is provided through a `better-effect` `Layer`.

```text
Queue.define → Job → enqueue / awaitResult
                         ↓
                    JobStore
                         ↓
                Worker.service → Worker.handle
```

## Install

```bash
bun add better-effect-mq better-effect better-result
```

The package expects `better-effect >=0.13`, `better-result ^3`, and TypeScript
6 or newer. Use the package's `npm` or `pnpm` equivalent if that is how your
application manages dependencies.

## Quick start: a complete in-memory queue

This complete program defines a typed job, composes a Layer-owned worker,
submits one item, waits for its result, and disposes the Runtime. The same
application code works with a durable adapter after replacing the store Layer.

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import { Codec, JobStore, MemoryJobStore, Queue, Worker } from 'better-effect-mq'

const Emails = Queue.define('emails')
const SendEmail = Emails.job('send-email', {
  version: 1,
  payload: Codec.json<{ readonly recipient: string }>(),
  result: Codec.string
})

const store = MemoryJobStore.make()
const handler = Worker.handle(SendEmail, (payload) =>
  Effect.fn(async function* () {
    console.log(`sending to ${payload.recipient}`)
    return Result.ok(`sent:${payload.recipient}`)
  })
)

const EmailWorker = Worker.service('@app/EmailWorker')
const EmailWorkerLive = EmailWorker.layer(() => ({
  handlers: [handler] as const,
  concurrency: 1,
  pollIntervalMs: 10
}))

const AppLive = Layer.complete(
  Layer.merge(Layer.succeed(JobStore, JobStore.of(store)), Layer.merge(ClockLive, EmailWorkerLive))
)
const runtime = await Runtime.make(AppLive)

try {
  const worker = await runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* EmailWorker)
    })
  )
  if (Result.isError(worker)) throw worker.error

  const completed = await runtime.run(() =>
    Effect.gen(async function* () {
      const jobId = yield* SendEmail.enqueue({ recipient: 'ada@example.test' })
      const result = yield* SendEmail.awaitResult(jobId)
      return Result.ok({ jobId, result })
    })
  )
  if (Result.isError(completed)) throw completed.error

  console.log(completed.value)
  await worker.value.awaitIdle()
} finally {
  await runtime.dispose()
}
```

`MemoryJobStore` is process-local and intentionally disposable. It is useful
for examples, tests, and local development; use a durable adapter when work
must survive a restart or be shared by multiple processes.

## Define jobs with `Queue` and `Job`

`Queue.define` creates a namespace. A Job descriptor gives one work type a
stable identity and declares the codecs used at the storage boundary:

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

The payload is the decoded value passed to the handler. Result and failure
codecs control what producers and operators can read back. Defaults provide
retry and timeout policy; enqueue options can override the per-item schedule.
The descriptor is inert: defining a Job does not resolve a Service, create a
worker, or register anything globally.

## `JobStore`: the persistence seam

`JobStore` is a yieldable Service, not a database client. The adapter contract
covers enqueueing, claiming and leasing, settlement, heartbeats, stalled-job
recovery, inspection, administration, and optional queue wake-ups. Provide the
adapter through a Layer:

```ts
const jobs = MemoryJobStore.make()
const AppStorage = Layer.succeed(JobStore, JobStore.of(jobs))
```

A durable adapter provides the same `JobStore` token through its own Layer.
The `Job`, `Worker`, `enqueue`, and `awaitResult` calls do not change when the
storage provider changes. Use `JobStore.named('billing')` when one Runtime
contains independent stores; bind each Job to the store it belongs to.

## Workers and producer operations

`Worker.handle(job, handler)` connects a Job to a typed `better-effect`
program. A handler receives the decoded payload and can yield application
Services. `JobContext` provides the job ID, attempt number, delivery count,
metadata, and worker identity for the current attempt.

`Worker.service(tag)` returns a Layer-first Service. Acquiring its Layer starts
the supervisor; Runtime shutdown stops it. Workers support bounded concurrency,
queue and handler limits, retries, timeouts, lease heartbeats, stalled
recovery, and graceful stop.

Every Job exposes yieldable producer operations:

| Operation                    | Use it for                                          |
| ---------------------------- | --------------------------------------------------- |
| `enqueue`                    | Submit one decoded payload and receive its `JobId`. |
| `enqueueMany`                | Submit a batch while retaining input order.         |
| `poll`                       | Read one job snapshot without waiting.              |
| `awaitResult`                | Wait for a terminal result or typed failure.        |
| `execute`                    | Enqueue and wait in one operation.                  |
| `attempts`                   | Read the delivery ledger for one job.               |
| `cancel`, `retry`, `promote` | Apply explicit job administration.                  |

## Flow: coordinate a parent execution

Flow solves the fan-out/fan-in problem: one parent Job can create multiple
typed child Jobs, wait until they settle, and collect their outcomes as one
parent result. Use it when a request naturally consists of parallel or
dependent steps that need durable progress and a single result; use ordinary
Jobs when each unit can be submitted and observed independently.

The example below is complete and compilable. It defines a parent and two
child Jobs, registers child handlers and a Flow handler on one Worker, provides
the Job and Flow persistence services, enqueues the parent, and awaits the
collected result. See [`examples/flow/main.ts`](./examples/flow/main.ts) for
the runnable copy.

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import {
  Codec,
  Flow,
  FlowStore,
  JobStore,
  MemoryFlowStore,
  MemoryJobStore,
  Queue,
  Worker
} from 'better-effect-mq'

const Reports = Queue.define('examples.reports')
const RunReport = Reports.job('run-report', {
  version: 1,
  payload: Codec.json<{ readonly reportId: string }>(),
  result: Codec.json<{ readonly completed: number; readonly failed: number }>(),
  failure: Codec.json<{ readonly code: string }>()
})
const BuildReport = Reports.job('build-report', {
  version: 1,
  payload: Codec.json<{ readonly reportId: string }>(),
  result: Codec.json<{ readonly reportId: string; readonly rows: number }>(),
  failure: Codec.json<{ readonly code: string }>()
})
const NotifyReport = Reports.job('notify-report', {
  version: 1,
  payload: Codec.json<{ readonly reportId: string }>(),
  result: Codec.string,
  failure: Codec.json<{ readonly code: string }>()
})

const ReportFlow = Flow.define('report-flow', {
  parent: RunReport,
  children: [BuildReport, NotifyReport] as const,
  onChildFailure: 'continue'
})

const ReportFlowHandler = Flow.handle(ReportFlow, {
  fanOut: (payload) =>
    Effect.fn(async function* () {
      return Result.ok([
        Flow.children(BuildReport, [{ key: 'build', payload: { reportId: payload.reportId } }]),
        Flow.children(NotifyReport, [{ key: 'notify', payload: { reportId: payload.reportId } }])
      ] as const)
    }),
  collect: (_payload, results) =>
    Effect.fn(async function* () {
      return Result.ok({
        completed: results.counts.completed,
        failed: results.counts.failed
      })
    })
})

const handlers = [
  Worker.handle(BuildReport, (payload) =>
    Effect.fn(async function* () {
      return Result.ok({ reportId: payload.reportId, rows: 42 })
    })
  ),
  Worker.handle(NotifyReport, (payload) =>
    Effect.fn(async function* () {
      return Result.ok(`notified:${payload.reportId}`)
    })
  )
] as const

const ReportsWorker = Worker.service('@examples/ReportsWorker')
const ReportsWorkerLive = ReportsWorker.layer(() => ({
  handlers,
  flows: [ReportFlowHandler] as const,
  concurrency: 2,
  pollIntervalMs: 1,
  flowSweepIntervalMs: 2,
  flowBatchSize: 16
}))

// A durable adapter provides these same two Service tokens with its own Layer.
const jobs = MemoryJobStore.make()
const flows = MemoryFlowStore.make()
const AppLive = Layer.complete(
  Layer.merge(
    Layer.succeed(JobStore, JobStore.of(jobs)),
    Layer.merge(
      Layer.succeed(FlowStore, FlowStore.of(flows)),
      Layer.merge(ClockLive, ReportsWorkerLive)
    )
  )
)
const runtime = await Runtime.make(AppLive)

try {
  const worker = await runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* ReportsWorker)
    })
  )
  if (Result.isError(worker)) throw worker.error

  const execution = await runtime.run(() =>
    Effect.gen(async function* () {
      const jobId = yield* RunReport.enqueue({ reportId: 'daily-2026-01-01' })
      const result = yield* RunReport.awaitResult(jobId)
      return Result.ok({ jobId, result })
    })
  )
  if (Result.isError(execution)) throw execution.error

  console.log(execution.value)
  await worker.value.awaitIdle({ timeoutMs: 2_000 })
} finally {
  await runtime.dispose()
}
```

`Flow.define` is an immutable descriptor. `Flow.handle` supplies `fanOut` and
`collect` programs; `Flow.children` keeps each child payload typed. Register
the Flow handler in the options returned by
`Worker.service(...).layer(() => ({ flows }))` and register ordinary child
handlers in `handlers`. The Flow store records the parent, child manifest,
terminal reports, and relay work. For production, replace both memory
providers with the durable adapter's matching `JobStore` and `FlowStore`
Layers. The Flow API remains the same.

`onChildFailure: 'continue'` collects successful and failed children. Use
`'fail'` when the first failed child should fail the parent and cascade the
remaining work.

## Events and observing results

Polling is the default and needs only a `JobStore`. To use a durable event log
as a wake-up hint, provide the matching `JobEventStore` in the same Runtime:

```ts
import { Effect, Layer } from 'better-effect'
import { Result } from 'better-result'
import { JobEventStore, JobStore, MemoryJobEventStore, MemoryJobStore } from 'better-effect-mq'

const events = MemoryJobEventStore.make({
  retention: { count: 1_000, ageMs: 24 * 60 * 60 * 1_000 }
})
const jobs = MemoryJobStore.make({ eventStore: events })
const AppStorage = Layer.merge(
  Layer.succeed(JobStore, JobStore.of(jobs)),
  Layer.succeed(JobEventStore, JobEventStore.of(events))
)

const result = Effect.gen(async function* () {
  return Result.ok(
    yield* SendEmail.awaitResult(jobId, {
      strategy: 'events',
      eventStore: JobEventStore,
      pollFallbackMs: 5_000
    })
  )
})
```

An event is a wake-up hint, not the source of truth: `awaitResult` rereads the
Job record before decoding the terminal result or failure. Event retention is
bounded, and a failed event read can fall back to polling. The
`JobEventStore`, detailed `job.attempts(jobId)` ledger, and process-local
`JobObserver` are complementary surfaces; none replaces the others.

## Outbox: make a transaction handoff durable

The optional [`better-effect-mq-outbox`](../better-effect-mq-outbox/README.md)
extension solves the database dual-write problem. It is not a second queue API:
you still define a Job with `Queue.define`, route a prepared request to the
core `JobStore`, and process it with the same `Worker.handle` handler. The
extension adds a transaction-bound outbox record and a Runtime-owned publisher:

```text
database transaction
  ├─ write the order
  └─ append a prepared Job request
        │ commit
        ▼
OutboxPublisher → core JobStore → Worker.handle(SendConfirmation)
```

The transaction-to-publisher shape is:

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, JobStore, Queue, Worker } from 'better-effect-mq'
import { Result } from 'better-result'
import { OutboxId, OutboxPublisher, OutboxRoutes, makeOutboxRecord } from 'better-effect-mq-outbox'
import { PostgresJobStore, PostgresOutbox, type Pool } from 'better-effect-mq-postgres'

declare const pool: Pool
const Orders = Queue.define('orders')
const SendConfirmation = Orders.job('send-confirmation', {
  version: 1,
  payload: Codec.json<{ readonly orderId: string; readonly email: string }>(),
  result: Codec.string,
  store: JobStore,
  defaults: { attempts: 5 },
  idempotencyKey: ({ orderId }) => `order-confirmation:${orderId}`
})

const confirmationHandler = Worker.handle(SendConfirmation, (payload) =>
  Effect.fn(async function* () {
    return Result.ok(`sent:${payload.email}`)
  })
)
const QueueWorker = Worker.service('@app/OrderWorker')
const QueueWorkerLive = QueueWorker.layer(() => ({
  handlers: [confirmationHandler] as const,
  concurrency: 2,
  pollIntervalMs: 100
}))

const Routes = OutboxRoutes.make({ jobs: JobStore })
const Publisher = OutboxPublisher.service('OrderOutboxPublisher')
const PublisherLive = Publisher.layer(() => ({
  outboxes: [PostgresOutbox] as const,
  routes: Routes,
  concurrency: 4,
  pollIntervalMs: 1_000
}))
const AppLive = Layer.complete(
  Layer.merge(
    ClockLive,
    PostgresJobStore.layer({ pool, namespace: 'orders' }),
    PostgresOutbox.layer({ pool, namespace: 'orders' }),
    PublisherLive,
    QueueWorkerLive
  )
)
const runtime = await Runtime.make(AppLive)

const prepared = await runtime.run(() =>
  Effect.gen(async function* () {
    return Result.ok(
      yield* SendConfirmation.prepare({ orderId: 'order-123', email: 'ada@example.test' })
    )
  })
)
if (Result.isError(prepared)) throw prepared.error
const record = makeOutboxRecord({
  id: OutboxId.make('order-confirmation:order-123').unwrap(),
  target: 'jobs',
  request: prepared.value,
  attemptsMax: 5
})
if (Result.isError(record)) throw record.error

const transaction = await pool.connect()
try {
  await transaction.query('BEGIN')
  await transaction.query('INSERT INTO orders (id, email) VALUES ($1, $2)', [
    'order-123',
    'ada@example.test'
  ])
  await PostgresOutbox.appendIn(transaction, record.value, { namespace: 'orders' })
  await transaction.query('COMMIT')
} catch (cause) {
  await transaction.query('ROLLBACK')
  throw cause
} finally {
  transaction.release()
}
```

After commit, the publisher enqueues the prepared request into the routed
`JobStore`; the normal worker then runs `SendConfirmation`. The complete
PostgreSQL setup, connection ownership rules, and adapter equivalents are in
the outbox extension's [transaction-to-publisher example](../better-effect-mq-outbox/README.md#end-to-end-example-with-postgresql).

## Reliability

- Delivery is at least once, not exactly once. Make handler side effects
  idempotent with the Job ID or an application key.
- Leases and fencing prevent an old worker from settling a newer delivery, but
  they cannot undo an external side effect that already happened.
- Typed failures can be retried according to `Retry` and the Job's `retryable`
  policy. Timeouts, cancellations, codec failures, and defects remain
  distinguishable for operators.
- Worker shutdown is cooperative. Runtime disposal stops admitting new work,
  lets active attempts settle according to its policy, and closes owned
  resources.
- Event retention is bounded. An EventLog is not an infinite archive or a
  replacement for payload/result storage.

## Testing and further reading

The package's runnable examples can be checked with:

```bash
bun run typecheck:examples
bun run test:examples
bunx tsc -p examples/flow/tsconfig.json --pretty false
bun examples/flow/main.ts
```

The [examples README](./examples/README.md) describes each runnable example.
For application-facing adapter composition, see the [composition guide](./docs/composition.md).
For adapter authors and maintainers, see the [driver author guide](./docs/writing-a-driver.md)
and the [technical protocol notes](./docs/protocol/).
