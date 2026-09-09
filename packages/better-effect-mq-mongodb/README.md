# better-effect-mq-mongodb

MongoDB adapter for the durable services in [`better-effect-mq`](../better-effect-mq): job queues, schedules, flows, events, and outbox. Applications continue to use the `better-effect-mq` APIs; this package only provides the Layers that connect those APIs to a MongoDB database.

## What it solves and when to choose MongoDB

Choose this adapter when your application already runs on MongoDB and needs:

- durable jobs with enqueue, claim, settlement, retries, cancellation, pausing, resuming, and inspection;
- namespace isolation and support for multiple queues or stores in the same database;
- transactional operations for state changes, schedules, flows, and outbox;
- optional durable events with retention by age or count;
- a single operational model for application state and queue state.

MongoDB is a good choice when BSON/document payloads, existing cluster operations, and multi-document transactions matter. Prefer a relational adapter when relational reporting and SQL tools are the priority, or Redis/Valkey when minimizing queue latency is the priority.

The package does not start workers or define jobs. Those behaviors belong to `better-effect-mq` and can use the same Runtime that provides this Layer.

## Installation

```bash
bun add better-effect-mq-mongodb better-effect better-effect-mq better-effect-mq-outbox better-result better-effect-schema zod mongodb
```

The public peers are:

| Package                   | Range                           |
| ------------------------- | ------------------------------- |
| `better-effect`           | `>=0.13.0 <0.14.0`              |
| `better-effect-mq`        | `>=0.1.0 <0.2.0`                |
| `better-effect-mq-outbox` | `>=0.1.0 <0.2.0`                |
| `better-result`           | `^3.0.0`                        |
| `mongodb`                 | `>=6.0.0 <8.0.0`, optional peer |
| `typescript`              | `>=6.0.0`                       |

`mongodb` is optional because the adapter accepts a `Db` already created by the application. With this approach, importing the package does not load the driver. Use the `mongodb` peer when you want `layerFromConfig` to open the connection for you.

## Quick start: a complete durable worker

`better-effect-mq-mongodb` is a storage adapter, not a second job framework. Define queues and jobs with `better-effect-mq`, register handlers with `Worker.handle`, start them with `Worker.service`, and provide `MongoJobStore.layer` as the durable `JobStore` implementation:

```ts
import * as z from 'zod'
import { MongoClient } from 'mongodb'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, JobContext, JobEncodeFailure, Queue, Worker } from 'better-effect-mq'
import { Schema as CoreSchema } from 'better-effect-schema'
import { Schema } from 'better-effect-schema/zod'
import { Result } from 'better-result'
import { MongoJobStore } from 'better-effect-mq-mongodb'

const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/?replicaSet=rs0'
const client = new MongoClient(uri)
await client.connect()
const db = client.db('application')

await MongoJobStore.migrate({ db })

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})
class SendEmailPayload extends Schema.Class<SendEmailPayload>('app/SendEmailPayload')({
  recipient: z.email(),
  requestedAt: DateFromISOString
}) {}
const SendEmailResult = z.object({ status: z.literal('sent'), recipient: z.email() })
const sendEmailPayloadCodec = Codec.standardSchema({
  schema: SendEmailPayload,
  encode: (value) =>
    CoreSchema.encode(SendEmailPayload, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})
const sendEmailResultCodec = Codec.standardSchema({ schema: SendEmailResult })

const Emails = Queue.define('application.emails')
const SendEmail = Emails.job('send-email', {
  version: 1,
  payload: sendEmailPayloadCodec,
  result: sendEmailResultCodec
})

const handler = Worker.handle(SendEmail, (payload) =>
  Effect.fn(async function* () {
    const context = yield* JobContext
    console.log(
      `attempt ${context.attempt}: sending to ${payload.recipient} at ${payload.requestedAt.toISOString()}`
    )
    return Result.ok({ status: 'sent' as const, recipient: payload.recipient })
  })
)

const ApplicationWorker = Worker.service('ApplicationEmailWorker')
const ApplicationWorkerLive = ApplicationWorker.layer(() => ({
  handlers: [handler] as const,
  concurrency: 4,
  pollIntervalMs: 100
}))

const ApplicationLive = Layer.complete(
  Layer.merge(
    MongoJobStore.layer({ db, namespace: 'application' }),
    Layer.merge(ClockLive, ApplicationWorkerLive)
  )
)

const runtime = await Runtime.make(ApplicationLive)
await runtime.warmup()

try {
  const started = await runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* ApplicationWorker)
    })
  )
  if (Result.isError(started)) throw started.error

  const completed = await runtime.run(() =>
    Effect.gen(async function* () {
      const payload = Schema.decodeUnknown(SendEmailPayload, {
        recipient: 'ada@example.test',
        requestedAt: '2026-09-09T10:00:00.000Z'
      })
      if (Result.isError(payload)) throw payload.error
      const jobId = yield* SendEmail.enqueue(payload.value, { idempotencyKey: 'welcome-ada' })
      const result = yield* SendEmail.awaitResult(jobId)
      return Result.ok({ jobId, result })
    })
  )
  if (Result.isError(completed)) throw completed.error

  console.log(completed.value)
  await started.value.awaitIdle()
} finally {
  await runtime.dispose()
  await client.close()
}
```

The preconfigured Zod `Schema` facade uses the Zod 4 provider;
`CoreSchema.encode` projects the decoded `SendEmailPayload` class to JSON, and
`Codec.standardSchema` reuses that contract for persisted Job payloads and
results. The Worker receives the inferred decoded class type, while
`MongoJobStore` remains responsible only for durable storage. The Flow and
Outbox journeys below use the same schema-first payload boundary. Result or
failure values that are already plain JSON may use a concise
`Codec.standardSchema` shape; the payload boundaries in both journeys remain
schema-first.

This is the complete application flow: `Queue.define` and `Emails.job` create immutable, storage-neutral descriptors; `Worker.handle` connects the typed payload to application code; `Worker.service(...).layer(...)` owns the worker lifecycle; and `MongoJobStore.layer` supplies the `JobStore` used by `enqueue` and `awaitResult`. The worker does not query MongoDB, and application operations use the Services supplied by the Layer.

The `Db` must come from the official driver and retain access to its `MongoClient` (`db.client`), which is required to open transactional sessions. See the [`better-effect-mq` composition guide](../better-effect-mq/docs/composition.md) for more worker and handler patterns.

### Adapter-managed client

When you prefer to pass a URI instead of a `Db`, use the equivalent Layer:

```ts
const StoreLive = MongoJobStore.layerFromConfig({
  uri,
  database: 'application',
  namespace: 'application'
})
```

`layerFromConfig` creates and closes the `MongoClient` with the Runtime. Migration remains an explicit operation and should be run with an administrative `Db` before starting the application.

## Migrations and operational requirements

Before the first execution of a Layer, apply the corresponding migration:

```ts
await MongoJobStore.migrate({ db })
```

The command is idempotent. The Layer validates the existing layout by default (`validateLayout: true`) and fails fast when the migration is missing or incompatible; it does not modify the database automatically. `collectionPrefix` lets you separate adapter installations in the same database, and `namespace` separates logical application stores.

If the application uses flows, also apply the flows migration after the main migration:

```ts
import { MongoFlowStore, MongoJobStore } from 'better-effect-mq-mongodb'

await MongoJobStore.migrate({ db })
await MongoFlowStore.migrate({ db })
```

Schedules, events, and outbox use the main migration; no migration runs automatically while these Layers are acquired.

MongoDB must support transactions: use a replica set (a single-node replica set is sufficient for development) or a mongos deployment that supports transactions. Standalone MongoDB is rejected when the Layer is acquired. This requirement applies to jobs, schedules, flows, and outbox.

> **`Db` ownership:** `MongoJobStore.layer`, `MongoJobScheduleStore.layer`, `MongoFlowStore.layer`, `MongoJobEventStore.layer`, and `MongoOutboxStore.layer` use the supplied `Db` but do not close the application's `MongoClient`. The code that created the client must close it after `runtime.dispose()`. The `layerFromConfig` variants create the client and take responsibility for closing it.

Operational recommendations:

- keep `validateLayout` enabled in production;
- configure backups, retention, monitoring, index capacity, and document-size limits for your application's volume;
- choose `notifications: 'poll'` when change streams are unavailable; the default mode (`'auto'`) uses change streams only as a wake-up signal and keeps polling as a fallback;
- keep `collectionPrefix` stable after a migration and use the same value in every Layer that shares the layout.

## Composition with `better-effect-mq` and events

`better-effect-mq` defines the `JobStore` contract. The adapter Layer provides that contract:

```ts
import { JobStore } from 'better-effect-mq'
import { MongoJobStore } from 'better-effect-mq-mongodb'

const Durable = JobStore.named('durable')
const DurableStoreLive = MongoJobStore.layerFor(Durable, {
  db,
  namespace: 'application'
})
```

Use `layerFor` when multiple stores need to coexist in the same Runtime. Jobs associated with the `Durable` token must be provided by this Layer. When direct store access is useful, yield the token inside an Effect running on that Runtime:

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { JobStore } from 'better-effect-mq'
import { Result } from 'better-result'
import { MongoJobStore } from 'better-effect-mq-mongodb'

const Durable = JobStore.named('durable')
const DurableLive = Layer.complete(
  MongoJobStore.layerFor(Durable, {
    db,
    namespace: 'application'
  })
)

const runtime = await Runtime.make(DurableLive)
try {
  const countsResult = await runtime.run(() =>
    Effect.gen(async function* () {
      const store = yield* Durable
      const counts = yield* Result.await(Promise.resolve(store.counts()))
      return Result.ok(counts)
    })
  )
  if (Result.isError(countsResult)) throw countsResult.error
  console.log(countsResult.value)
} finally {
  await runtime.dispose()
}
```

### Durable events

Events are optional. To provide `JobStore` and `JobEventStore` together, use:

```ts
import { MongoJobStore } from 'better-effect-mq-mongodb'

const DurableWithEvents = MongoJobStore.layerWithEvents(
  { db, namespace: 'application' },
  { retention: { ageMs: 7 * 24 * 60 * 60 * 1_000, count: 100_000 } }
)
```

You can also provide only `MongoJobEventStore.layer(...)` or associate the event store with a named token using `layerFor`. Reading uses monotonic cursors and pagination; cursors beyond the retention window return an expiration error. The log records safe transitions, not job payloads, results, full failures, or arbitrary metadata.

With `layerWithEvents`, the job transition and its event are committed or rolled back together. Waiting for events may use change streams as a low-latency hint, but keeps polling to recover from reconnects and gaps. Publishing events to external systems remains the application's responsibility.

## Available capabilities

### Queues and controls

The adapter implements the `JobStore` used by `better-effect-mq`: idempotent enqueue, concurrent claim, settlement with a result or retry, cancellation, recovery of interrupted jobs, pausing/resuming, and bounded queries. It also supports the queue controls exposed by `better-effect-mq`, including global concurrency, per-key concurrency, and per-time-window limits.

The `Worker` from `better-effect-mq` remains responsible for running handlers, supervising attempts, and shutting down in an orderly manner. The MongoDB Layer provides only the persistence required for these cycles.

### Schedules

Schedules are provided in a separate Layer:

```ts
import { JobScheduleStore } from 'better-effect-mq'
import { MongoJobScheduleStore } from 'better-effect-mq-mongodb'

const SchedulesLive = MongoJobScheduleStore.layer({
  db,
  namespace: 'application'
})
```

Compose `SchedulesLive` with the Layer for the associated `JobStore`. Ticks use a transactional compare-and-set operation, insert deterministic occurrences, wake the queue, and advance the schedule as a single observable change. For named stores, create the associated token and provide it explicitly:

```ts
const DurableSchedules = JobScheduleStore.for(Durable)
const NamedSchedulesLive = MongoJobScheduleStore.layerFor(DurableSchedules, {
  db,
  namespace: 'application'
})
```

### Flows

Flows are defined by `better-effect-mq`; MongoDB supplies the durable
`FlowStore` and `JobStore` behind the same APIs. The canonical
[order-fulfillment Flow example](../better-effect-mq/README.md#flow-coordinate-a-parent-execution)
defines `FulfillOrder`, its typed inventory and payment children, the two child
handlers, `FulfillmentHandler`, and `FulfillmentWorkerLive`. The concrete
MongoDB continuation below provides those descriptors with durable storage and
enqueues the same meaningful parent payload:

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { MongoFlowStore, MongoJobStore } from 'better-effect-mq-mongodb'
import { Result } from 'better-result'

// Continue with FulfillOrder and FulfillmentWorkerLive from the canonical
// order-fulfillment Flow example linked above. `db` is the application-owned
// database from the MongoDB setup section.
const FlowStorageLive = Layer.merge(
  MongoJobStore.layer({ db, namespace: 'application' }),
  MongoFlowStore.layer({ db, namespace: 'application' })
)
const AppLive = Layer.complete(
  Layer.merge(FlowStorageLive, Layer.merge(ClockLive, FulfillmentWorkerLive))
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

The parent enqueue starts `fanOut` once. MongoDB durably stores the parent
manifest, child progress, terminal reports, and relay work; the Worker uses the
ordinary `JobStore` to deliver children and `collect` reads their outcomes from
`FlowStore`. Delivery is at least once, so child handlers and external effects
must be safe to replay. For a named JobStore, provide the associated flow token
with `MongoFlowStore.layerFor` as shown below.

For an independent job store in the same Runtime, use a named job token and
the adapter's matching flow Layer:

```ts
import { JobStore } from 'better-effect-mq'
import { MongoFlowStore } from 'better-effect-mq-mongodb'

const BillingJobs = JobStore.named('billing')
const BillingFlowLive = MongoFlowStore.layerFor(BillingJobs, {
  db,
  namespace: 'application'
})
```

The adapter persists child fan-out, child results, cancellation, reconciliation, and pending reports for delivery to the parent. Delivery is at least once and can be repeated safely. Different stores do not participate in a single transaction; there is no guarantee of an atomic commit across databases or namespaces. A flow migration is required in addition to the main job migration:

```ts
await MongoJobStore.migrate({ db })
await MongoFlowStore.migrate({ db })
```

### Outbox

For transactional handoff from domain writes to jobs, use
[`better-effect-mq-outbox`](../better-effect-mq-outbox/README.md) with the
adapter-owned MongoDB transaction helper. `MongoOutboxStore.layer` persists
records, `OutboxPublisher` delivers them to a `JobStore` after commit, and
`MongoOutbox.transaction` receives an application-owned `Db` or `MongoClient`,
then owns the session lifecycle around the domain write and append. A
`layerFromConfig` provider owns only the client used by its provider Layer; it
does not supply the static transaction helper.

```ts
import * as z from 'zod'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, JobEncodeFailure, JobStore, Queue, Worker } from 'better-effect-mq'
import { Schema as CoreSchema } from 'better-effect-schema'
import { Schema } from 'better-effect-schema/zod'
import { Result } from 'better-result'
import {
  OutboxId,
  OutboxPublisher,
  OutboxRoutes,
  OutboxStore,
  makeOutboxRecord
} from 'better-effect-mq-outbox'
import { MongoJobStore, MongoOutbox, MongoOutboxStore } from 'better-effect-mq-mongodb'

class ConfirmationPayload extends Schema.Class<ConfirmationPayload>('app/ConfirmationPayload')({
  orderId: z.string(),
  recipient: z.email()
}) {}
const confirmationPayloadCodec = Codec.standardSchema({
  schema: ConfirmationPayload,
  encode: (value) =>
    CoreSchema.encode(ConfirmationPayload, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})

const Orders = Queue.define('application.orders')
const SendConfirmation = Orders.job('send-confirmation', {
  version: 1,
  payload: confirmationPayloadCodec,
  result: Codec.standardSchema({ schema: z.string() }),
  idempotencyKey: ({ orderId }) => `confirmation:${orderId}`
})
const confirmationHandler = Worker.handle(SendConfirmation, (payload) =>
  Effect.fn(async function* () {
    console.log(`sending order confirmation for ${payload.orderId} to ${payload.recipient}`)
    return Result.ok(`sent:${payload.orderId}`)
  })
)
const ApplicationWorker = Worker.service('ApplicationOrderWorker')
const ApplicationWorkerLive = ApplicationWorker.layer(() => ({
  handlers: [confirmationHandler] as const,
  concurrency: 4,
  pollIntervalMs: 100
}))

const Routes = OutboxRoutes.make({ jobs: JobStore })
const Publisher = OutboxPublisher.service('ApplicationOutboxPublisher')
const PublisherLive = Publisher.layer(() => ({
  outboxes: [OutboxStore] as const,
  routes: Routes,
  concurrency: 2,
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 1_000
}))

const ApplicationLive = Layer.complete(
  Layer.merge(
    MongoJobStore.layer({ db, namespace: 'application' }),
    Layer.merge(
      MongoOutboxStore.layer({ db, namespace: 'application' }),
      Layer.merge(ClockLive, Layer.merge(ApplicationWorkerLive, PublisherLive))
    )
  )
)

const runtime = await Runtime.make(ApplicationLive)
await runtime.warmup()

const preparedResult = await runtime.run(() =>
  Effect.gen(async function* () {
    const payload = Schema.decodeUnknown(ConfirmationPayload, {
      orderId: 'order-123',
      recipient: 'ada@example.test'
    })
    if (Result.isError(payload)) throw payload.error
    const prepared = yield* SendConfirmation.prepare(payload.value, {
      jobId: 'order-confirmation:order-123'
    })
    return Result.ok(prepared)
  })
)
if (Result.isError(preparedResult)) throw preparedResult.error

const record = makeOutboxRecord({
  id: OutboxId.make('order-confirmation:order-123').unwrap(),
  target: 'jobs',
  request: preparedResult.value,
  attemptsMax: 5
})
if (Result.isError(record)) throw record.error

const transactionResult = await MongoOutbox.transaction(
  db,
  record.value,
  async (session) => {
    await db
      .collection('orders')
      .insertOne({ _id: 'order-123', email: 'ada@example.test' }, { session })
    return Result.ok({ orderId: 'order-123', outboxId: record.value.id })
  },
  { namespace: 'application' }
)
if (Result.isError(transactionResult)) throw transactionResult.error

// The publisher observes the committed record and enqueues the prepared request.
const jobResult = await runtime.run(() =>
  Effect.gen(async function* () {
    const jobId = record.value.request.id
    if (jobId === undefined) throw new Error('the prepared request has no job ID')
    const result = yield* SendConfirmation.awaitResult(jobId)
    return Result.ok({ jobId, result })
  })
)
if (Result.isError(jobResult)) throw jobResult.error
console.log(jobResult.value)

// Keep the Runtime alive while the application is serving requests.
await runtime.dispose()
```

Prepare the job before calling the application transaction helper. The request
is fully encoded and can be stored safely. `MongoOutbox.transaction` receives
the database, prepared record, and domain callback; it appends that record
after the callback succeeds, then commits both writes together. It owns the
session, transaction, and cleanup, aborts thrown/rejected or nominal
`Result.err` outcomes, and always ends the session. MongoDB may retry a
transaction callback after a transient error, so domain writes in the callback
must be safe to retry.

Pass a `MongoClient` as the first argument when the database is not available
there; in that form provide the database as `options.db` so the adapter can
append to the selected database. The payload uses the same schema-first
boundary (the preconfigured Zod `Schema`, `Schema.Class`, and `CoreSchema.encode`), while
concise result/failure codecs are suitable for plain-JSON outcomes.

`Routes` maps the record target `'jobs'` to the `JobStore` Service token; it
does not capture a store instance. The publisher resolves that token in the
Runtime before enqueueing the prepared request.

### Advanced: caller-owned transactions

`MongoOutbox.appendIn` remains available only as an advanced escape hatch for
code that intentionally owns the session and transaction lifecycle.

After commit, the running `OutboxPublisher` claims the record and calls the
`jobs` route. The `JobStore` receives the prepared request, and the outbox
record is marked published only after enqueue succeeds. Delivery is at least
once, so use deterministic IDs and make handlers safe to retry.

For a named outbox store, bind the token explicitly:

```ts
import { OutboxStore } from 'better-effect-mq-outbox'
import { MongoOutboxStore } from 'better-effect-mq-mongodb'

const BillingOutbox = OutboxStore.named('billing')
const BillingOutboxLive = MongoOutboxStore.layerFor(BillingOutbox, {
  db,
  namespace: 'billing'
})
```

## Durability guarantees and limits

- Mutable adapter operations use MongoDB transactions with snapshot reads and `majority` commit.
- Enqueue, claim, settlement, retry, cancellation, schedules, flows, and outbox operations each have one atomic unit in the same database and namespace.
- Repeating an idempotent operation does not create a second logical state; callers can retry lost responses.
- Delivery of jobs, consumed events, and outbox entries is at least once. Consumers must persist their cursors or acknowledgements and tolerate duplicates.
- Change streams are only a wake-up optimization; unavailability or reconnection must not be treated as state loss.
- The adapter does not provide distributed transactions, exactly-once external publication, cross-database queues, unlimited event storage, or automatic backups.
- Maximum document size, index capacity, retention, and backup recovery remain limits and responsibilities of the MongoDB environment.

For the jobs, workers, schedules, and flows API, see the [public `better-effect-mq` documentation](../better-effect-mq/README.md). For MongoDB-specific operational details, consult the documentation for the deployment used by your application.

## Plain JSON escape hatch

For a trusted JSON-safe payload, use the small core codec directly:

```ts
const AuditJob = Queue.define('audit').job('record', {
  version: 1,
  payload: Codec.json<{ readonly event: string }>()
})
```

Use Zod 4 through `better-effect-schema/zod` when the Job should validate and
decode untrusted input at its boundary.
