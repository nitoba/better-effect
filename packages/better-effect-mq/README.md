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
bun add better-effect-mq better-effect better-result better-effect-schema zod
```

The package expects `better-effect >=0.13`, `better-result ^3`, and TypeScript
6 or newer. `better-effect-schema` and `zod` are optional integration packages;
install them when a job crosses an untrusted boundary and needs runtime
validation. Use the package's `npm` or `pnpm` equivalent if that is how your
application manages dependencies.

## Quick start: a schema-backed in-memory queue

This complete program uses Zod through `better-effect-schema` to validate the
wire payload, construct a schema-backed class for the handler, and encode that
class back to JSON for the Job boundary. It composes a Layer-owned worker,
submits one item, waits for its result, and disposes the Runtime. The same
application code works with a durable adapter after replacing the store Layer.

```ts
import * as z from 'zod'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import { Codec, JobEncodeFailure, JobStore, MemoryJobStore, Queue, Worker } from 'better-effect-mq'
import { Schema } from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'

const local = Schema.with(ZodAdapter)

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class UserEvent extends local.Class<UserEvent>('app/UserEvent')({
  eventId: z.uuid(),
  occurredAt: DateFromISOString,
  kind: z.string().min(1),
  payload: z.record(z.string(), z.string())
}) {}

const DeliveryReceipt = z.object({
  accepted: z.literal(true),
  eventId: z.uuid()
})

const DeliveryFailure = z.object({
  code: z.string().min(1),
  retryable: z.boolean()
})

const UserEventCodec = Codec.standardSchema({
  schema: UserEvent,
  encode: (value) =>
    Schema.encode(UserEvent, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})

const ReceiptCodec = Codec.standardSchema({ schema: DeliveryReceipt })
const FailureCodec = Codec.standardSchema({ schema: DeliveryFailure })

const Events = Queue.define('events')
const IngestEvent = Events.job('ingest-event', {
  version: 1,
  payload: UserEventCodec,
  result: ReceiptCodec,
  failure: FailureCodec,
  idempotencyKey: ({ eventId }) => eventId,
  retryable: ({ retryable }) => retryable
})

const store = MemoryJobStore.make()
const handler = Worker.handle(IngestEvent, (event) =>
  Effect.fn(async function* () {
    console.log(`handling ${event.kind} at ${event.occurredAt.toISOString()}`)
    return Result.ok({ accepted: true as const, eventId: event.eventId })
  })
)

const EventsWorker = Worker.service('@app/EventsWorker')
const EventsWorkerLive = EventsWorker.layer(() => ({
  handlers: [handler] as const,
  concurrency: 1,
  pollIntervalMs: 10
}))

const AppLive = Layer.complete(
  Layer.merge(Layer.succeed(JobStore, JobStore.of(store)), Layer.merge(ClockLive, EventsWorkerLive))
)
const runtime = await Runtime.make(AppLive)

try {
  const started = await runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* EventsWorker)
    })
  )
  if (Result.isError(started)) throw started.error

  const completed = await runtime.run(() =>
    Effect.gen(async function* () {
      const jobId = yield* IngestEvent.enqueue({
        eventId: '550e8400-e29b-41d4-a716-446655440000',
        occurredAt: '2026-09-02T10:00:00.000Z',
        kind: 'user.created',
        payload: { source: 'example' }
      })
      const receipt = yield* IngestEvent.awaitResult(jobId)
      return Result.ok({ jobId, receipt })
    })
  )
  if (Result.isError(completed)) throw completed.error

  console.log(completed.value)
  await started.value.awaitIdle()
} finally {
  await runtime.dispose()
}
```

`MemoryJobStore` is process-local and intentionally disposable. It is useful
for examples, tests, and local development; use a durable adapter when work
must survive a restart or be shared by multiple processes.

The schema-backed codec decodes persisted JSON into the class used by the
handler; the explicit `encode` callback delegates the wire projection to
`Schema.encode`. If a provider schema's output is already JSON-safe, omit
`encode` and the codec uses that value for both sides.

Use `Codec.json<T>()` when a value is already plain JSON and a separate runtime
validator would add no value—for example, a small internal-only payload or a
primitive result. Prefer a schema-backed codec for HTTP, database, queue, or
other untrusted boundaries where runtime validation, normalized failures, or a
decoded domain class matters.

## Advanced: raw Standard Schema interoperability

`Codec.standardSchema` can bridge a schema that implements the Standard Schema
contract when no provider adapter is available. Prefer a native provider such
as Zod 4 through `better-effect-schema`; hand-writing a `StandardSchemaV1`
object is an adapter/interoperability escape hatch, not the recommended Job
definition path.

## Define jobs with `Queue` and `Job`

`Queue.define` creates a namespace. A Job descriptor gives one work type a
stable identity and declares the codecs used at the storage boundary:

```ts
import * as z from 'zod'
import { Codec, Queue, Retry } from 'better-effect-mq'

const Billing = Queue.define('billing')
const ChargeCardPayload = z.object({
  paymentId: z.string().min(1),
  amountCents: z.int().positive()
})
const ChargeCardResult = z.object({ receiptId: z.string().min(1) })
const ChargeCardFailure = z.object({ code: z.string().min(1) })

const ChargeCard = Billing.job('charge-card', {
  version: 1,
  payload: Codec.standardSchema({ schema: ChargeCardPayload }),
  result: Codec.standardSchema({ schema: ChargeCardResult }),
  failure: Codec.standardSchema({ schema: ChargeCardFailure }),
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
worker, or register anything globally. For a payload whose in-memory value is
different from its wire value—such as a `Date` or a schema class—provide the
explicit encoder shown in the quick start.

The `version` identifies the persisted Job contract. Increment it when a
payload, result, or typed failure changes incompatibly.

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

| Operation                    | Use it for                                      |
| ---------------------------- | ----------------------------------------------- |
| `enqueue`                    | Submit one codec input and receive its `JobId`. |
| `enqueueMany`                | Submit a batch while retaining input order.     |
| `poll`                       | Read one job snapshot without waiting.          |
| `awaitResult`                | Wait for a terminal result or typed failure.    |
| `execute`                    | Enqueue and wait in one operation.              |
| `attempts`                   | Read the delivery ledger for one job.           |
| `cancel`, `retry`, `promote` | Apply explicit job administration.              |

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

const persisted = await PostgresOutbox.transaction(
  pool,
  record.value,
  async (transaction) => {
    await transaction.query('INSERT INTO orders (id, email) VALUES ($1, $2)', [
      'order-123',
      'ada@example.test'
    ])
    return Result.ok(undefined)
  },
  { namespace: 'orders' }
)
if (Result.isError(persisted)) throw persisted.error
```

Prepare the request and record before calling the adapter helper. The adapter
appends the record after the domain callback succeeds and owns the connection,
commit, rollback, and cleanup. After commit, the publisher enqueues the prepared request into the routed
`JobStore`; the normal worker then runs `SendConfirmation`. The complete
PostgreSQL setup, connection ownership rules, and adapter equivalents are in
the outbox extension's [transaction-to-publisher example](../better-effect-mq-outbox/README.md#end-to-end-example-with-postgresql).

### Advanced: caller-owned transactions

Adapters may expose `appendIn` as an escape hatch when application code already
owns a native transaction. It is not part of the normal outbox path; use the
adapter's record-first `transaction` helper for application writes.

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
For adapter authors and maintainers, see the [driver author guide](./docs/writing-a-driver.md).
