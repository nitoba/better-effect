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
bun add better-effect-mq-mongodb better-effect better-effect-mq better-effect-mq-outbox better-result mongodb
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

## Quick start: an application-owned `Db` and a Layer

The recommended flow is to connect the client, run the migration explicitly, and provide the `Db` to the adapter:

```ts
import { MongoClient } from 'mongodb'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, Queue } from 'better-effect-mq'
import { Result } from 'better-result'
import { MongoJobStore } from 'better-effect-mq-mongodb'

const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/?replicaSet=rs0'
const client = new MongoClient(uri)
await client.connect()
const db = client.db('application')

await MongoJobStore.migrate({ db })

const Emails = Queue.define('emails')
const SendEmail = Emails.job('send', {
  version: 1,
  payload: Codec.json<{ readonly to: string }>()
})

const ApplicationLive = Layer.complete(
  Layer.merge(MongoJobStore.layer({ db, namespace: 'application' }), ClockLive)
)
const runtime = await Runtime.make(ApplicationLive)

try {
  const result = await runtime.run(() =>
    Effect.gen(async function* () {
      const jobId = yield* SendEmail.enqueue(
        { to: 'ada@example.test' },
        { idempotencyKey: 'welcome-ada' }
      )
      return Result.ok(jobId)
    })
  )

  if (Result.isError(result)) throw result.error
  console.log(result.value)
} finally {
  await runtime.dispose()
  await client.close()
}
```

The `Db` must come from the official driver and retain access to its `MongoClient` (`db.client`), which is required to open transactional sessions.

The worker, handlers, and result reading use only `better-effect-mq`. For example, a worker can be added to the same `ApplicationLive` with `Worker.service` and `Worker.handle`, without querying collections or knowing about MongoDB. See the [`better-effect-mq` composition guide](../better-effect-mq/docs/composition.md) for that side of the application.

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

Use `layerFor` when multiple stores need to coexist in the same Runtime. Jobs associated with the `Durable` token must be provided by this Layer; the application does not need to resolve services manually.

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

Flows use an explicit Layer and their own migration:

```ts
import { MongoFlowStore } from 'better-effect-mq-mongodb'

const FlowLive = MongoFlowStore.layer({
  db,
  namespace: 'application'
})
```

The adapter persists child fan-out, child results, cancellation, reconciliation, and pending reports for delivery to the parent. Delivery is at least once and can be repeated safely. Different stores do not participate in a single transaction; there is no guarantee of an atomic commit across databases or namespaces.

### Outbox

For the `OutboxStore` from [`better-effect-mq-outbox`](../better-effect-mq-outbox/README.md), use:

```ts
import { MongoOutboxStore, OutboxStore } from 'better-effect-mq-mongodb'

const OutboxLive = MongoOutboxStore.layer({
  db,
  namespace: 'billing'
})

const NamedOutboxLive = MongoOutboxStore.layerFor(OutboxStore.named('billing'), {
  db,
  namespace: 'billing'
})
```

`MongoOutbox.appendIn(session, record, options)` integrates a record into a MongoDB transaction that the application has already opened. The application owns the session, commit/abort, and `endSession()`. After the commit, `OutboxStore` provides claims with expiration, heartbeat, settlement, and recovery; external publication is at least once and must be explicitly confirmed with `markPublished`.

## Durability guarantees and limits

- Mutable adapter operations use MongoDB transactions with snapshot reads and `majority` commit.
- Enqueue, claim, settlement, retry, cancellation, schedules, flows, and outbox operations each have one atomic unit in the same database and namespace.
- Repeating an idempotent operation does not create a second logical state; callers can retry lost responses.
- Delivery of jobs, consumed events, and outbox entries is at least once. Consumers must persist their cursors or acknowledgements and tolerate duplicates.
- Change streams are only a wake-up optimization; unavailability or reconnection must not be treated as state loss.
- The adapter does not provide distributed transactions, exactly-once external publication, cross-database queues, unlimited event storage, or automatic backups.
- Maximum document size, index capacity, retention, and backup recovery remain limits and responsibilities of the MongoDB environment.

For the jobs, workers, schedules, and flows API, see the [public `better-effect-mq` documentation](../better-effect-mq/README.md). For MongoDB-specific operational details, consult the documentation for the deployment used by your application.
