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

The package expects `better-effect >=0.14 <0.15`, `better-result ^3`, and TypeScript
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
import { Schema as CoreSchema } from 'better-effect-schema'
import { Schema } from 'better-effect-schema/zod'

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class UserEvent extends Schema.Class<UserEvent>('app/UserEvent')({
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
    CoreSchema.encode(UserEvent, value).mapError(
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
`CoreSchema.encode`. If a provider schema's output is already JSON-safe, omit
`encode` and the codec uses that value for both sides.

### Plain JSON escape hatch

For internal or otherwise simple data that is already JSON-safe, `Codec.json<T>()`
is the smallest option:

```ts
const InternalPing = Queue.define('internal').job('ping', {
  version: 1,
  payload: Codec.json<{ readonly requestId: string }>(),
  result: Codec.string
})
```

Prefer a schema-backed codec for HTTP, database, queue, or other untrusted
boundaries where runtime validation, normalized failures, or a decoded domain
class matters.

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
import { Codec, JobEncodeFailure, Queue, Retry } from 'better-effect-mq'
import { Schema as CoreSchema } from 'better-effect-schema'
import { Schema } from 'better-effect-schema/zod'

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

const Billing = Queue.define('billing')
class ChargeCardPayload extends Schema.Class<ChargeCardPayload>('app/ChargeCardPayload')({
  paymentId: z.string().min(1),
  amountCents: z.int().positive(),
  requestedAt: DateFromISOString
}) {}
const ChargeCardResult = z.object({ receiptId: z.string().min(1) })
const ChargeCardFailure = z.object({ code: z.string().min(1) })
const ChargeCardPayloadCodec = Codec.standardSchema({
  schema: ChargeCardPayload,
  encode: (value) =>
    CoreSchema.encode(ChargeCardPayload, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})

const ChargeCard = Billing.job('charge-card', {
  version: 1,
  payload: ChargeCardPayloadCodec,
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

Flow solves the fan-out/fan-in problem: one durable parent Job can create
typed child Jobs, wait until every child reaches a terminal state, and publish
one aggregate parent result. For example, order fulfillment can reserve each
line and charge the order in parallel while keeping one order-level lifecycle.
That gives operators one parent to inspect or retry, instead of a collection of
unrelated jobs whose relationship only exists in application logs.

The example below is complete and compilable. It uses provider-backed Zod 4
schemas at every persisted payload boundary, fans out to two different child
Job types, implements both child handlers, collects useful fulfillment output,
and awaits the terminal parent result. See
[`examples/flow/main.ts`](./examples/flow/main.ts) for a small runnable,
plain-JSON variant.

```ts
import * as z from 'zod'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import {
  Codec,
  Flow,
  FlowStore,
  JobEncodeFailure,
  JobStore,
  MemoryFlowStore,
  MemoryJobStore,
  Queue,
  Worker
} from 'better-effect-mq'
import { Schema as CoreSchema } from 'better-effect-schema'
import { Schema } from 'better-effect-schema/zod'

const OrderItem = z.object({ sku: z.string().min(1), quantity: z.int().positive() })
const OrderFailure = z.object({ code: z.string().min(1), message: z.string().min(1) })

class FulfillOrderPayload extends Schema.Class<FulfillOrderPayload>('app/FulfillOrderPayload')({
  orderId: z.string().min(1),
  currency: z.string().length(3),
  totalCents: z.int().positive(),
  items: z.array(OrderItem).min(1)
}) {}
const FulfillOrderPayloadCodec = Codec.standardSchema({
  schema: FulfillOrderPayload,
  encode: (value) =>
    CoreSchema.encode(FulfillOrderPayload, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})

class ReserveInventoryPayload extends Schema.Class<ReserveInventoryPayload>(
  'app/ReserveInventoryPayload'
)({
  orderId: z.string().min(1),
  sku: z.string().min(1),
  quantity: z.int().positive()
}) {}
const ReserveInventoryPayloadCodec = Codec.standardSchema({
  schema: ReserveInventoryPayload,
  encode: (value) =>
    CoreSchema.encode(ReserveInventoryPayload, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})
const ReserveInventoryResult = z.object({
  kind: z.literal('inventory'),
  sku: z.string().min(1),
  reservedQuantity: z.int().nonnegative()
})

class ChargeOrderPayload extends Schema.Class<ChargeOrderPayload>('app/ChargeOrderPayload')({
  orderId: z.string().min(1),
  currency: z.string().length(3),
  amountCents: z.int().positive()
}) {}
const ChargeOrderPayloadCodec = Codec.standardSchema({
  schema: ChargeOrderPayload,
  encode: (value) =>
    CoreSchema.encode(ChargeOrderPayload, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})
const ChargeOrderResult = z.object({
  kind: z.literal('payment'),
  chargeId: z.string().min(1),
  amountCents: z.int().positive()
})

const FulfillOrderResult = z.object({
  orderId: z.string().min(1),
  requestedItems: z.int().nonnegative(),
  reservedItems: z.int().nonnegative(),
  payment: z.enum(['charged', 'not-charged']),
  failedChildren: z.array(z.string())
})

const Orders = Queue.define('orders')
const FulfillOrder = Orders.job('fulfill-order', {
  version: 1,
  payload: FulfillOrderPayloadCodec,
  result: Codec.standardSchema({ schema: FulfillOrderResult }),
  failure: Codec.standardSchema({ schema: OrderFailure })
})
const ReserveInventory = Orders.job('reserve-inventory', {
  version: 1,
  payload: ReserveInventoryPayloadCodec,
  result: Codec.standardSchema({ schema: ReserveInventoryResult }),
  failure: Codec.standardSchema({ schema: OrderFailure })
})
const ChargeOrder = Orders.job('charge-order', {
  version: 1,
  payload: ChargeOrderPayloadCodec,
  result: Codec.standardSchema({ schema: ChargeOrderResult }),
  failure: Codec.standardSchema({ schema: OrderFailure })
})

const Fulfillment = Flow.define('order-fulfillment', {
  parent: FulfillOrder,
  children: [ReserveInventory, ChargeOrder] as const,
  onChildFailure: 'continue'
})

const FulfillmentHandler = Flow.handle(Fulfillment, {
  fanOut: (payload) =>
    Effect.fn(async function* () {
      return Result.ok([
        Flow.children(
          ReserveInventory,
          payload.items.map((item) => ({
            key: `reserve:${item.sku}`,
            payload: { orderId: payload.orderId, sku: item.sku, quantity: item.quantity }
          }))
        ),
        Flow.children(ChargeOrder, [
          {
            key: 'charge',
            payload: {
              orderId: payload.orderId,
              currency: payload.currency,
              amountCents: payload.totalCents
            }
          }
        ])
      ] as const)
    }),
  collect: (payload, results) =>
    Effect.fn(async function* () {
      const children = yield* Result.await(results.all()())
      const reservedItems = children.filter(
        (child) => child.outcome === 'completed' && child.result?.kind === 'inventory'
      ).length
      const charged = children.some(
        (child) => child.outcome === 'completed' && child.result?.kind === 'payment'
      )
      const payment = charged ? ('charged' as const) : ('not-charged' as const)
      return Result.ok({
        orderId: payload.orderId,
        requestedItems: payload.items.length,
        reservedItems,
        payment,
        failedChildren: children
          .filter((child) => child.outcome !== 'completed')
          .map((child) => child.childKey)
      })
    })
})

const handlers = [
  Worker.handle(ReserveInventory, (payload) =>
    Effect.fn(async function* () {
      // Reserve payload.sku in inventory; make that write idempotent by order ID and SKU.
      return Result.ok({
        kind: 'inventory' as const,
        sku: payload.sku,
        reservedQuantity: payload.quantity
      })
    })
  ),
  Worker.handle(ChargeOrder, (payload) =>
    Effect.fn(async function* () {
      // Pass payload.orderId as the payment provider's idempotency key.
      return Result.ok({
        kind: 'payment' as const,
        chargeId: `charge:${payload.orderId}`,
        amountCents: payload.amountCents
      })
    })
  )
] as const

const FulfillmentWorker = Worker.service('@app/FulfillmentWorker')
const FulfillmentWorkerLive = FulfillmentWorker.layer(() => ({
  handlers,
  flows: [FulfillmentHandler] as const,
  concurrency: 4,
  pollIntervalMs: 10,
  flowSweepIntervalMs: 50,
  flowBatchSize: 32
}))

// Replace these process-local providers with the matching durable adapter Layers in production.
const AppLive = Layer.complete(
  Layer.merge(
    Layer.succeed(JobStore, JobStore.of(MemoryJobStore.make())),
    Layer.merge(
      Layer.succeed(FlowStore, FlowStore.of(MemoryFlowStore.make())),
      Layer.merge(ClockLive, FulfillmentWorkerLive)
    )
  )
)
const runtime = await Runtime.make(AppLive)

try {
  const execution = await runtime.run(() =>
    Effect.gen(async function* () {
      const parentId = yield* FulfillOrder.enqueue({
        orderId: 'order-123',
        currency: 'USD',
        totalCents: 12_500,
        items: [
          { sku: 'coffee-beans', quantity: 2 },
          { sku: 'pour-over-kit', quantity: 1 }
        ]
      })
      const result = yield* FulfillOrder.awaitResult(parentId)
      return Result.ok({ parentId, result })
    })
  )
  if (Result.isError(execution)) throw execution.error
  console.log(execution.value)
} finally {
  await runtime.dispose()
}
```

`Flow.define` is an immutable descriptor. `Flow.handle` supplies `fanOut` and
`collect` programs; `Flow.children` keeps each child payload tied to its Job
definition, so adding a payment child cannot accidentally receive an inventory
payload. The Flow store records the parent, child manifest, terminal reports,
and relay work while the JobStore handles ordinary child delivery.

With `onChildFailure: 'continue'`, `collect` runs after all children settle and
can return a partial result such as two reservations and `payment:
'not-charged'`. Use `onChildFailure: 'fail'` when the parent must fail as soon
as a child fails and remaining work should be cancelled. Both policies keep
the parent-child relationship durable and replayable; choose based on whether
partial fulfillment is useful to the caller.

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
import * as z from 'zod'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, JobEncodeFailure, JobStore, Queue, Worker } from 'better-effect-mq'
import { Result } from 'better-result'
import { Schema as CoreSchema } from 'better-effect-schema'
import { Schema } from 'better-effect-schema/zod'
import { OutboxId, OutboxPublisher, OutboxRoutes, makeOutboxRecord } from 'better-effect-mq-outbox'
import { PostgresJobStore, PostgresOutbox, type Pool } from 'better-effect-mq-postgres'

declare const pool: Pool
const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class ConfirmationPayload extends Schema.Class<ConfirmationPayload>('app/ConfirmationPayload')({
  orderId: z.string().min(1),
  email: z.email(),
  queuedAt: DateFromISOString
}) {}

const ConfirmationPayloadCodec = Codec.standardSchema({
  schema: ConfirmationPayload,
  encode: (value) =>
    CoreSchema.encode(ConfirmationPayload, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})

const Orders = Queue.define('orders')
const SendConfirmation = Orders.job('send-confirmation', {
  version: 1,
  payload: ConfirmationPayloadCodec,
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
await runtime.warmup()

const prepared = await runtime.run(() =>
  Effect.gen(async function* () {
    return Result.ok(
      yield* SendConfirmation.prepare(
        {
          orderId: 'order-123',
          email: 'ada@example.test',
          queuedAt: '2026-09-09T12:00:00.000Z'
        },
        { jobId: 'order-confirmation:order-123' }
      )
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

const completed = await runtime.run(() =>
  Effect.gen(async function* () {
    const result = yield* SendConfirmation.awaitResult('order-confirmation:order-123')
    return Result.ok(result)
  })
)
if (Result.isError(completed)) throw completed.error
console.log(completed.value)
await runtime.dispose()
```

Prepare the request and record before calling the adapter helper. The adapter
appends the record after the domain callback succeeds and owns the connection,
commit, rollback, and cleanup. After commit, the Runtime-owned publisher
enqueues the prepared request into the routed `JobStore`; the Runtime-owned
Worker then runs `SendConfirmation`, and `awaitResult` observes the terminal
result. The complete
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
