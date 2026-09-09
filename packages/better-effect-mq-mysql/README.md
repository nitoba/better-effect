# better-effect-mq-mysql

`better-effect-mq-mysql` is the MySQL adapter for `better-effect-mq`. It gives a
queue a durable home in MySQL while keeping `Queue`/`Job` descriptors, Workers,
retries, and application code in the storage-neutral `better-effect-mq`
package. It is a provider Layer, not an independent job API.

Use it when MySQL is already part of your production platform and you want:

- durable enqueue, claim, settlement, cancellation, and inspection;
- SQL-backed operations, backups, replication, and familiar database tooling;
- schedules, durable job events, flows, and an outbox that can share the same
  database and namespace;
- leases that fence stale workers, with no database connection held while a
  handler runs; and
- Layer-first composition with one `better-effect` Runtime.

This adapter is a good fit for durable background work and database-adjacent
workflows. It is not an exactly-once system, a replacement for a streaming
platform, or a cross-database transaction coordinator. Delivery and publishing
are at least once, so handlers and external side effects must be safe to repeat.

## Installation

For a caller-owned `mysql2` pool:

```sh
bun add better-effect-mq-mysql better-effect-mq better-effect better-result better-effect-schema zod mysql2
```

Add the outbox foundations when you use the outbox integration; the publisher
still runs in the same Runtime as the JobStore and Worker:

```sh
bun add better-effect-mq-outbox
```

The current package peer ranges are:

| Package                   | Supported range    |
| ------------------------- | ------------------ |
| `better-effect`           | `>=0.13.0 <0.14.0` |
| `better-effect-mq`        | `>=0.1.0 <0.2.0`   |
| `better-effect-mq-outbox` | `>=0.1.0 <0.2.0`   |
| `better-result`           | `^3.0.0`           |
| `mysql2`                  | `>=3.0.0 <4.0.0`   |
| TypeScript                | `>=6.0.0`          |

`mysql2` is an optional peer because applications may pass an already-created
compatible pool. Install it when this package creates a pool from a URI or
pool configuration.

## Requirements and migration

The adapter supports MySQL **8.0.16 or newer**, with InnoDB tables and
`STRICT_TRANS_TABLES` enabled. MariaDB and older MySQL versions are not
supported. The adapter checks server compatibility when it opens a store, and
the default `validateSchema: true` also checks that the database has the
complete current layout.

Run the explicit migrator from a deployment step, release job, or other
coordinated bootstrap. Store acquisition never runs migrations for you:

```ts
import { createPool } from 'mysql2/promise'
import { MySqlMigrator } from 'better-effect-mq-mysql'

const uri = process.env.MYSQL_URL
if (uri === undefined) throw new Error('MYSQL_URL is required')

const pool = createPool(uri)
try {
  await MySqlMigrator.run(pool)
  console.log('MySQL MQ schema is ready')
  await MySqlMigrator.validate(pool)
} finally {
  await pool.end()
}
```

The migrator is forward-only and safe to rerun. Run it before starting workers,
and run it again as part of an upgrade before enabling code that uses a newly
installed capability. `MySqlMigrator.validate(pool)` is useful as a separate
deployment or readiness check. A layer with `validateSchema: false` skips the
full catalog check only when that check is managed elsewhere; it still checks
server compatibility.

## Quick start: pool, Layer, and Worker

The following is a complete shape for a small application. The pool is created
by the application, migrated before the Runtime starts, and borrowed by the
MySQL layer.

```ts
import * as z from 'zod'
import { createPool } from 'mysql2/promise'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, Queue, Retry, Worker } from 'better-effect-mq'
import { Schema } from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'
import { MySqlJobStore, MySqlMigrator } from 'better-effect-mq-mysql'
import { Result } from 'better-result'

const uri = process.env.MYSQL_URL
if (uri === undefined) throw new Error('MYSQL_URL is required')

const pool = createPool(uri)
await MySqlMigrator.run(pool)

const local = Schema.with(ZodAdapter)
const SendEmailPayload = z.object({ messageId: z.string().min(1), recipient: z.email() })
const SendEmailResult = z.object({ status: z.literal('sent'), recipient: z.email() })
const sendEmailPayloadCodec = Codec.standardSchema({ schema: SendEmailPayload })
const sendEmailResultCodec = Codec.standardSchema({ schema: SendEmailResult })

const Emails = Queue.define('app.emails')
const SendEmail = Emails.job('send-email', {
  version: 1,
  payload: sendEmailPayloadCodec,
  result: sendEmailResultCodec,
  defaults: {
    attempts: 3,
    backoff: Retry.fixed({ delayMs: 1_000, maxAttempts: 3 }),
    timeoutMs: 30_000
  },
  idempotencyKey: ({ messageId }) => messageId
})

const EmailWorker = Worker.service('@app/EmailWorker')
const emailHandler = Worker.handle(SendEmail, (payload) =>
  Effect.fn(async function* () {
    // Call the email provider here. Make that call idempotent by messageId.
    return Result.ok({ status: 'sent' as const, recipient: payload.recipient })
  })
)

const AppLive = Layer.complete(
  Layer.merge(
    MySqlJobStore.layer({ pool, namespace: 'billing' }),
    Layer.merge(
      ClockLive,
      EmailWorker.layer(() => ({
        handlers: [emailHandler] as const,
        concurrency: 4,
        pollIntervalMs: 500
      }))
    )
  )
)

const runtime = await Runtime.make(AppLive)
await runtime.warmup()

try {
  const enqueued = await runtime.run(() =>
    Effect.gen(async function* () {
      const payload = local.decodeUnknown(SendEmailPayload, {
        messageId: 'message-123',
        recipient: 'ada@example.test'
      })
      if (Result.isError(payload)) throw payload.error
      const jobId = yield* SendEmail.enqueue(payload.value)
      return Result.ok(jobId)
    })
  )
  if (Result.isError(enqueued)) throw enqueued.error
} finally {
  await runtime.dispose()
  await pool.end()
}
```

`Schema.with(ZodAdapter)` provides the provider-backed validation boundary;
`Codec.standardSchema` adapts the same Zod 4 schemas to durable Job payloads
and results. `Worker.handle` receives the inferred decoded payload type.

`namespace` is the logical boundary for one application or tenant. Use the
same namespace when composing the JobStore and its extensions. If you run
independent stores in one database, use the associated named tokens and their
`layerFor` forms instead of creating another Runtime.

## Pool ownership

There are two equivalent ways to choose who owns connections:

```ts
// The application owns `pool`; the layer never calls pool.end().
const Borrowed = MySqlJobStore.layer({
  pool,
  namespace: 'billing'
})

// The layer creates a mysql2/promise pool and closes it with its Layer scope.
const Owned = MySqlJobStore.layerFromConfig({
  uri,
  namespace: 'billing',
  poolConfig: { connectionLimit: 12 }
})
```

The `layerFromConfig` form loads `mysql2/promise` lazily, creates the pool when
the layer is acquired, and closes that pool when the Runtime scope is released.
The same choice is available on `MySqlJobScheduleStore`,
`MySqlJobEventStore`, and `MySqlOutboxStore`. `MySqlClient.fromPool` and
`MySqlClient.fromConfig` expose the corresponding lower-level choices for
migration or compatibility tooling.

The config form does not migrate automatically. Migrate the database before
acquiring the Runtime layer. If the application owns the pool, dispose the
Runtime first and call `pool.end()` afterward; if the adapter owns it, the
Runtime releases it for you. Do not close a borrowed pool from a store release
callback.

## Add the durable extensions

The base `JobStore` is enough for enqueueing and workers. Add only the
capabilities your application needs. These providers use the same Layer and
namespace conventions as the base store.

### Schedules

`MySqlJobScheduleStore` persists recurring work next to the associated
`JobStore`. Define schedules with `JobSchedules`, reconcile them at startup or
deployment, and run a `JobScheduler` to turn due occurrences into jobs. A
schedule tick is deterministic: retrying a lost response does not create a
second occurrence for the same slot.

```ts
import { Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { JobSchedules, JobScheduler } from 'better-effect-mq'
import { MySqlJobScheduleStore, MySqlJobStore } from 'better-effect-mq-mysql'

// Reuse SendEmail and AppWorkerLive from Quick Start.

const BillingSchedules = JobSchedules.define({
  group: 'billing',
  schedules: [
    JobSchedules.schedule(SendEmail, 'hourly-reminder', {
      everyMs: 60 * 60 * 1_000,
      payload: {
        messageId: 'hourly-reminder',
        recipient: 'ops@example.test'
      }
    })
  ] as const
})

const SchedulerLive = JobScheduler.service('@billing/Scheduler').layer(() => ({
  registries: [BillingSchedules] as const,
  startupReconcile: true,
  sweepIntervalMs: 1_000,
  batchSize: 100
}))

const SchedulingLive = Layer.complete(
  Layer.merge(
    Layer.merge(
      MySqlJobStore.layer({ pool, namespace: 'billing' }),
      MySqlJobScheduleStore.layer({ pool, namespace: 'billing' })
    ),
    Layer.merge(ClockLive, Layer.merge(SchedulerLive, AppWorkerLive))
  )
)

const runtime = await Runtime.make(SchedulingLive)
```

The schedule store is associated with a JobStore token. For a named store,
keep that association explicit:

```ts
import { JobScheduleStore, JobStore } from 'better-effect-mq'

const Durable = JobStore.named('durable')
const DurableSchedules = JobScheduleStore.for(Durable)

const DurableLive = Layer.merge(
  MySqlJobStore.layerFor(Durable, { pool, namespace: 'billing' }),
  MySqlJobScheduleStore.layerFor(DurableSchedules, { pool, namespace: 'billing' })
)
```

Schedules support cron or fixed intervals, time zones, pause/resume, overlap
policies, and bounded misfire policies. They are not a timer service by
themselves: keep a scheduler running for continuous ticking, or call the
schedule store operations from your own control loop.

### Durable events

`MySqlJobEventStore` is an optional, bounded event log for committed job,
schedule, flow, and controlled-queue transitions. Compose it with the matching
JobStore layer and choose retention explicitly:

```ts
import { Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { JobEventStore } from 'better-effect-mq'
import { MySqlJobEventStore, MySqlJobStore } from 'better-effect-mq-mysql'

// Reuse the SendEmail descriptor and AppWorkerLive from Quick Start.

const DurableLive = Layer.complete(
  Layer.merge(
    MySqlJobStore.layer({ pool, namespace: 'billing' }),
    Layer.merge(
      MySqlJobEventStore.layer({
        pool,
        namespace: 'billing',
        retention: { count: 100_000, ageMs: 7 * 24 * 60 * 60 * 1_000 }
      }),
      Layer.merge(ClockLive, AppWorkerLive)
    )
  )
)

const runtime = await Runtime.make(DurableLive)
```

Use the event store for resumable operational feeds or event-assisted waits:

```ts
const completed = await runtime.run(() =>
  Effect.gen(async function* () {
    const jobId = yield* SendEmail.enqueue({
      messageId: 'message-456',
      recipient: 'grace@example.test'
    })
    return Result.ok(
      yield* SendEmail.awaitResult(jobId, {
        strategy: 'events',
        eventStore: JobEventStore,
        pollFallbackMs: 5_000
      })
    )
  })
)
```

The fallback is bounded polling and remains authoritative if a notification is
late or lost. Retention is finite; consumers must handle an expired cursor by
rebasing or requesting a replay from another source. Event records contain
bounded operational fields and safe attributes, not job payloads, results,
complete failure bodies, or arbitrary metadata. Use the detailed attempt
ledger for debugging and a process-local observer for metrics and tracing.

For a named JobStore, use `JobEventStore.for(Durable)` and
`MySqlJobEventStore.layerFor(...)` with the same pool and namespace.

### Flows

`MySqlFlowStore` provides the durable parent/child state needed by `Flow`
definitions and Worker flow handlers. It is created explicitly, then provided
under the associated `FlowStore` token:

```ts
import { Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { FlowStore } from 'better-effect-mq'
import { MySqlFlowStore, MySqlJobStore } from 'better-effect-mq-mysql'

// Reuse the Queue/Job descriptors and AppWorkerLive from Quick Start.

const flow = await MySqlFlowStore.make({
  pool,
  namespace: 'billing'
})

const FlowLive = Layer.succeed(FlowStore, FlowStore.of(flow))
const AppWithFlows = Layer.complete(
  Layer.merge(
    Layer.merge(MySqlJobStore.layer({ pool, namespace: 'billing' }), FlowLive),
    Layer.merge(ClockLive, AppWorkerLive)
  )
)

const runtime = await Runtime.make(AppWithFlows)
try {
  // Register flow handlers and run the application while this Runtime is live.
} finally {
  await runtime.dispose()
  await flow.dispose()
}
```

Use `Flow.define` and `Flow.handle` from `better-effect-mq`; register the flow
handler in the Worker options with `flows: [handler]`. The adapter records the
parent manifest before child work proceeds, accepts an identical replay, and
rejects a conflicting replay. Child terminal reports are durable and
retryable, so a worker or relay can recover after a crash.

Flow relay and child execution across different JobStores are still at least
once. There is no transaction spanning multiple stores; design child handlers
and any external effects for duplicate delivery. If the flow store was opened
with `MySqlFlowStore.makeFromConfig`, it owns its pool and must be disposed by
the application (`await flow.dispose()`) when the surrounding Runtime stops.

### Outbox

Use `MySqlOutboxStore` when a domain write and a prepared job request must become
durable together. `MySqlOutbox.transaction` owns the connection and transaction
lifecycle while your callback performs the domain write; the adapter appends the
supplied prepared record automatically after the callback succeeds.

```ts
import * as z from 'zod'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, JobStore, Queue, Worker } from 'better-effect-mq'
import { MySqlJobStore, MySqlOutbox, MySqlOutboxStore, OutboxStore } from 'better-effect-mq-mysql'
import { OutboxId, OutboxPublisher, OutboxRoutes, makeOutboxRecord } from 'better-effect-mq-outbox'
import { Result } from 'better-result'

const SendEmail = Queue.define('billing').job('send-email', {
  version: 1,
  payload: Codec.standardSchema({
    schema: z.object({ messageId: z.string().min(1), recipient: z.email() })
  }),
  result: Codec.standardSchema({ schema: z.string() }),
  idempotencyKey: ({ messageId }) => messageId
})

const EmailWorker = Worker.service('@billing/EmailWorker')
const emailHandler = Worker.handle(SendEmail, (payload) =>
  Effect.fn(async function* () {
    return Result.ok(`sent:${payload.recipient}`)
  })
)
const EmailWorkerLive = EmailWorker.layer(() => ({
  handlers: [emailHandler] as const,
  concurrency: 2,
  pollIntervalMs: 100
}))

const ApplicationOutbox = OutboxStore.named('application')
const OutboxLive = MySqlOutboxStore.layerFor(ApplicationOutbox, {
  pool,
  namespace: 'billing'
})
const Routes = OutboxRoutes.make({ billingJobs: JobStore })
const Publisher = OutboxPublisher.service('@billing/OutboxPublisher')
const PublisherLive = Publisher.layer(() => ({
  outboxes: [ApplicationOutbox] as const,
  routes: Routes,
  concurrency: 2,
  pollIntervalMs: 100
}))

const AppLive = Layer.complete(
  Layer.merge(
    Layer.merge(MySqlJobStore.layer({ pool, namespace: 'billing' }), OutboxLive),
    Layer.merge(ClockLive, Layer.merge(EmailWorkerLive, PublisherLive))
  )
)
const runtime = await Runtime.make(AppLive)
await runtime.warmup()

const preparedResult = await runtime.run(() =>
  Effect.gen(async function* () {
    return Result.ok(
      yield* SendEmail.prepare(
        {
          messageId: 'message-789',
          recipient: 'lin@example.test'
        },
        { jobId: 'invoice-created:123' }
      )
    )
  })
)
if (Result.isError(preparedResult)) throw preparedResult.error

const record = makeOutboxRecord({
  id: OutboxId.make('invoice-created:123').unwrap(),
  target: 'billingJobs',
  request: preparedResult.value,
  nowMs: Date.now()
}).unwrap()

const committed = await MySqlOutbox.transaction(
  pool,
  record,
  async (connection) => {
    // Save the invoice in the same adapter-owned transaction.
    await connection.query('INSERT INTO invoices (id, status) VALUES (?, ?)', [
      'invoice-created:123',
      'created'
    ])
    return Result.ok(undefined)
  },
  { namespace: 'billing', token: ApplicationOutbox }
)
if (Result.isError(committed)) throw committed.error

const completed = await runtime.run(() =>
  Effect.gen(async function* () {
    return Result.ok(yield* SendEmail.awaitResult('invoice-created:123'))
  })
)
if (Result.isError(completed)) throw completed.error
await runtime.dispose()
```

Keep `target` equal to a route configured for the publisher, such as
`'billingJobs'`. The adapter appends the record after the domain callback
succeeds, commits only after both writes succeed, and cleans up the connection
on success or failure. Configure the publisher so that route points to the
JobStore that should receive the prepared request.

### Advanced: caller-owned transactions

`MySqlOutbox.appendIn` remains available only as an advanced escape hatch when
an application already owns a compatible transaction.

The store provides leases, retry, and recovery operations for that delivery
loop. A crash after publishing but before settlement can publish the same
record again; deterministic Job IDs or idempotency keys make retries converge.
The outbox is not exactly-once delivery.

## Durability, retries, and leases

The important operational guarantees are:

- A successful enqueue or state transition is durable in MySQL before the
  operation reports success. With events enabled, the corresponding event is
  appended as part of that committed transition.
- Job delivery is at least once. A worker can perform an external side effect
  and crash before settlement; use the Job ID, an idempotency key, or a
  provider-side idempotency mechanism to make that effect repeat-safe.
- Each delivery has a lease and a fencing token. When a lease expires, another
  worker may recover and claim the job. A stale worker cannot settle the newer
  delivery with its old token.
- Retry policy is part of the Job definition. Set `attempts`, a persisted
  `Retry.fixed`, `Retry.linear`, or `Retry.exponential` backoff, and a
  `retryable` predicate for typed failures. Transient MySQL deadlocks and lock
  wait timeouts are retried at the complete storage-operation boundary; a
  handler is never rerun inside a database transaction.
- Worker and publisher shutdown is graceful: new work stops, admitted work is
  allowed to finish, and leases remain recoverable if a process disappears.
- With QueueControls configured, the MySQL store enforces global concurrency,
  per-dispatch-key concurrency, and fixed-window rate limits durably. The
  producer's `dispatchKey` is persisted with the job, so workers do not derive
  a different key later.

## Limits and operational decisions

- This package supports MySQL 8.0.16+ and InnoDB. MariaDB is intentionally not
  advertised as compatible.
- The adapter is durable, but not exactly once. Database durability cannot
  undo an external side effect that happened before a crash.
- The MySQL queue is a database-backed work queue, not a high-throughput log or
  an infinite event archive. Size the pool for worker concurrency plus short
  administrative work, and monitor lock waits, deadlocks, query plans, storage,
  and replication lag.
- Event retention is bounded by count and/or age. An expired event cursor needs
  an explicit replay or rebase policy.
- Metadata filtering is a residual query rather than a general-purpose
  secondary index. Prefer explicit job identity, queue, and state filters for
  routine operations; do not assume arbitrary metadata queries will scale like
  indexed lookups.
- Schedules are durable declarations, but they need a running scheduler (or a
  deliberate control loop) to tick them. Misfire and overlap policies are
  application choices.
- Flow and outbox relays can redeliver. Cross-store fan-out and publishing do
  not become atomic merely because the stores use MySQL.
- Operators remain responsible for backups, replication, failover, credentials,
  capacity, and recovery drills.

## Further reading

For the shared APIs and composition patterns, see:

- [The `better-effect-mq` user guide](../better-effect-mq/README.md)
- [The `better-effect-mq` composition guide](../better-effect-mq/docs/composition.md)
- [Storage-neutral outbox foundations](../better-effect-mq-outbox/README.md)

The adapter's MySQL conformance suites run against a dedicated MySQL instance
when `MYSQL_URL` is set. Without it, unit, type, package, and artifact checks
still run; database-engine scenarios are skipped.

## Plain JSON escape hatch

When input is already a trusted JSON-safe value, the core `Codec.json<T>()`
codec remains available:

```ts
const AuditJob = Queue.define('audit').job('record', {
  version: 1,
  payload: Codec.json<{ readonly event: string }>()
})
```

Use a Zod 4 schema through `better-effect-schema/zod` when the Job should
validate and decode untrusted input at its boundary.
