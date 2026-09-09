# better-effect-mq-postgres

`better-effect-mq-postgres` is the PostgreSQL adapter for
[`better-effect-mq`](../better-effect-mq). It supplies a durable `JobStore`
for the core queue API and optional PostgreSQL stores for job events,
schedules, flows, and the outbox. It is an adapter, not a second jobs API:
application code still defines `Queue` and `Job` descriptors, registers
`Worker.handle` handlers, and composes one `Layer` and `Runtime`.

PostgreSQL gives the queue durable state, leases, retries, and recovery across
processes. Delivery remains at-least-once. If a process crashes after an
external side effect but before settlement, the job may run again; make
external effects idempotent with a job ID or an application idempotency key.

## Install

```bash
bun add better-effect-mq-postgres better-effect-mq better-effect better-result better-effect-schema zod pg
```

If you use the optional outbox publisher, also install:

```bash
bun add better-effect-mq-outbox
```

The package expects `better-effect >=0.13`, `better-effect-mq >=0.1`,
`better-result ^3`, and TypeScript 6 or newer. `pg` is an optional peer: it is
loaded lazily only by the `layerFromConfig` and `PostgresClient.fromConfig`
forms that create a pool. A caller-provided pool uses the adapter's small pool
interface and does not load `pg` itself.

## Quick start

Run migrations as an explicit deploy or startup step, define the queue and
jobs with `better-effect-mq`, then provide the PostgreSQL `JobStore` through a
Layer. The following is the complete application shape: one typed Job, one
Worker handler, one Runtime, and one durable store.

```ts
import * as z from 'zod'
import { Pool } from 'pg'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, JobContext, JobEncodeFailure, JobStore, Queue, Worker } from 'better-effect-mq'
import { Schema } from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'
import { Result } from 'better-result'
import { PostgresJobStore, PostgresMigrator } from 'better-effect-mq-postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
await PostgresMigrator.run(pool, { schema: 'public' })

const local = Schema.with(ZodAdapter)
const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})
class SendEmailPayload extends local.Class<SendEmailPayload>('app/SendEmailPayload')({
  recipient: z.email(),
  requestedAt: DateFromISOString
}) {}
const SendEmailResult = z.object({ status: z.literal('sent'), recipient: z.email() })
const sendEmailPayloadCodec = Codec.standardSchema({
  schema: SendEmailPayload,
  encode: (value) =>
    Schema.encode(SendEmailPayload, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})
const sendEmailResultCodec = Codec.standardSchema({ schema: SendEmailResult })

const Emails = Queue.define('emails')
const SendEmail = Emails.job('send-email', {
  version: 1,
  payload: sendEmailPayloadCodec,
  result: sendEmailResultCodec,
  idempotencyKey: (payload) => `send-email:${payload.recipient}`
})

const SendEmailHandler = Worker.handle(SendEmail, (payload) =>
  Effect.fn(async function* () {
    const context = yield* JobContext
    console.log(
      `attempt ${context.attempt}: sending to ${payload.recipient} at ${payload.requestedAt.toISOString()}`
    )
    return Result.ok({ status: 'sent' as const, recipient: payload.recipient })
  })
)

const EmailWorker = Worker.service('EmailWorker')
const EmailWorkerLive = EmailWorker.layer(() => ({
  handlers: [SendEmailHandler] as const,
  concurrency: 4,
  pollIntervalMs: 1_000
}))

const AppLive = Layer.complete(
  Layer.merge(PostgresJobStore.layer({ pool, namespace: 'mailing' }), ClockLive, EmailWorkerLive)
)

const runtime = await Runtime.make(AppLive)
await runtime.warmup()

try {
  const submitted = await runtime.run(() =>
    Effect.gen(async function* () {
      const payload = local.decodeUnknown(SendEmailPayload, {
        recipient: 'ada@example.test',
        requestedAt: '2026-09-09T10:00:00.000Z'
      })
      if (Result.isError(payload)) throw payload.error
      const jobId = yield* SendEmail.enqueue(payload.value)
      return Result.ok(jobId)
    })
  )
  if (Result.isError(submitted)) throw submitted.error

  const completed = await runtime.run(() =>
    Effect.gen(async function* () {
      const value = yield* SendEmail.awaitResult(submitted.value)
      return Result.ok(value)
    })
  )
  if (Result.isError(completed)) throw completed.error
  console.log(completed.value)
} finally {
  await runtime.dispose()
  await pool.end()
}
```

`Queue.define` and `Queue.job` only create immutable descriptors. They do not
open a connection or register a handler. The Zod 4 schema is validated through
the `better-effect-schema/zod` adapter, and `Schema.encode` projects the
decoded class back to JSON for the durable job boundary. `Codec.standardSchema`
keeps that contract in one codec. `Worker.handle` associates a typed payload
with a `better-effect` program, while `Worker.service(...).layer(...)` owns
polling, leases, attempts, and graceful worker shutdown. `runtime.run` provides
the declared Services and execution Scope; `awaitResult` reads the durable Job
until it reaches a terminal state. The later Flow and Outbox snippets use
smaller `z.object` Standard Schema codecs deliberately; they keep the same
provider-backed validation boundary when a decoded class is unnecessary.

The example uses `PostgresJobStore.layer`, so the application owns `pool` and
must call `pool.end()`. If the adapter should create and close the pool, use:

```ts
const AppStoreLive = PostgresJobStore.layerFromConfig({
  connectionString: process.env.DATABASE_URL,
  namespace: 'mailing'
})

const runtime = await Runtime.make(AppStoreLive)
// runtime.dispose() closes the pool created by the adapter.
```

Do not call `pool.end()` for a pool created by `layerFromConfig`.

## Migrations and configuration

The shipped schema supports PostgreSQL 12 or newer. Apply migrations before a
Runtime whose Layers validate the schema:

```ts
import { PostgresMigrator } from 'better-effect-mq-postgres'

await PostgresMigrator.run(pool, { schema: 'public' })
await PostgresMigrator.validate(pool, { schema: 'public' })
```

`run` is forward-only, ordered, checksummed, and protected by a transaction
advisory lock. It does not downgrade or remove data. Keep migration execution
in a controlled deploy step and leave `validateSchema: true` (the default) on
production Layers so incompatible or incomplete schemas fail during
acquisition. For a rolling deploy, add compatible schema changes first, then
deploy readers and writers, and remove obsolete columns only in a later
expand/migrate/contract step.

Every store accepts the same connection settings:

| Store     | Caller-owned pool                | Adapter-owned pool                         |
| --------- | -------------------------------- | ------------------------------------------ |
| Jobs      | `PostgresJobStore.layer`         | `PostgresJobStore.layerFromConfig`         |
| Events    | `PostgresJobEventStore.layer`    | `PostgresJobEventStore.layerFromConfig`    |
| Schedules | `PostgresJobScheduleStore.layer` | `PostgresJobScheduleStore.layerFromConfig` |
| Outbox    | `PostgresOutbox.layer`           | `PostgresOutbox.layerFromConfig`           |

Use the same `pool`, `schema`, and `namespace` for stores that must share a
state boundary. A namespace separates independent applications or environments
inside one PostgreSQL schema. `layerFor` and `layerFromConfigFor` provide a
named `JobStore`, `JobEventStore`, `JobScheduleStore`, or outbox token when one
Runtime contains independent stores.

## Optional job events

`PostgresJobEventStore` is a durable EventLog for compact transition facts,
cursor-based feeds, dashboards, and wake-ups. Compose it with the matching
`JobStore` in the same Runtime:

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { JobEventStore, JobStore } from 'better-effect-mq'
import { Result } from 'better-result'
import { PostgresJobEventStore, PostgresJobStore } from 'better-effect-mq-postgres'

const AppLive = Layer.complete(
  Layer.merge(
    PostgresJobStore.layer({ pool, namespace: 'mailing' }),
    PostgresJobEventStore.layer({
      pool,
      namespace: 'mailing',
      retention: { count: 100_000, ageMs: 7 * 24 * 60 * 60 * 1_000 }
    }),
    ClockLive,
    EmailWorkerLive
  )
)

const runtime = await Runtime.make(AppLive)
await runtime.warmup()
const completed = await runtime.run(() =>
  Effect.gen(async function* () {
    const jobId = yield* SendEmail.enqueue({ recipient: 'ada@example.test' })
    const value = yield* SendEmail.awaitResult(jobId, {
      strategy: 'events',
      eventStore: JobEventStore,
      pollFallbackMs: 5_000
    })
    return Result.ok({ jobId, value })
  })
)
await runtime.dispose()
```

An event is a wake hint, not the source of truth: `awaitResult` rereads the
Job record before decoding its result or failure, and the bounded poll fallback
keeps progress when a notification is delayed or lost. Retention is finite;
an expired cursor must be rebased or replayed from another source. Use the
EventLog for a resumable feed, the Job attempt ledger for per-delivery detail,
and a local `JobObserver` for best-effort logs and metrics.

## Durable schedules

`PostgresJobScheduleStore` persists schedule definitions and lets the core
`JobSchedules` and `JobScheduler` APIs reconcile and tick them. Schedules use
the same Job descriptors and Workers as manually enqueued work:

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { JobScheduleStore, JobScheduler, JobSchedules, JobStore } from 'better-effect-mq'
import { Result } from 'better-result'
import { PostgresJobScheduleStore, PostgresJobStore } from 'better-effect-mq-postgres'

const ReminderSchedules = JobSchedules.define({
  group: 'mailing',
  schedules: [
    JobSchedules.schedule(SendEmail, 'hourly-reminder', {
      everyMs: 60 * 60 * 1_000,
      payload: { recipient: 'ops@example.test' },
      overlap: 'skip'
    })
  ],
  stores: [JobStore]
})

const Scheduler = JobScheduler.service('ReminderScheduler')
const SchedulerLive = Scheduler.layer(() => ({
  registries: [ReminderSchedules] as const,
  startupReconcile: true,
  sweepIntervalMs: 30_000
}))

const AppLive = Layer.complete(
  Layer.merge(
    PostgresJobStore.layer({ pool, namespace: 'mailing' }),
    PostgresJobScheduleStore.layer({ pool, namespace: 'mailing' }),
    ClockLive,
    SchedulerLive
  )
)

const runtime = await Runtime.make(AppLive)
const report = await runtime.run(() =>
  Effect.gen(async function* () {
    return Result.ok(yield* JobSchedules.reconcile(ReminderSchedules, { nowMs: Date.now() }))
  })
)
```

The schedule store makes each tick duplicate-safe and associates schedules
with their JobStore token. Configure misfire and overlap policies on the
schedule; use a Worker to process the resulting Jobs. For named stores, pair
`JobScheduleStore.for(MyJobs)` with
`PostgresJobScheduleStore.layerFor(MySchedules, config)`.

## Flows: durable parent/child work

Use a Flow when one Job coordinates related work that should fan out to
children and then fan in to a parent result—for example, importing all lines
of an order, generating one report per customer, or reconciling a batch. The
parent and child Jobs remain normal Queue descriptors; the Flow adds durable
child state, reports, and recovery for the coordination step.

This example runs a parent import, creates one child Job per line, waits for
the children, and returns a typed aggregate result. `PostgresFlowStore` is an
explicit store, so provide it under the associated core `FlowStore` token in
the same Runtime as the JobStore and Worker.

```ts
import * as z from 'zod'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, Flow, FlowStore, JobEncodeFailure, Queue, Worker } from 'better-effect-mq'
import { Schema } from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'
import { Result } from 'better-result'
import { PostgresFlowStore, PostgresJobStore } from 'better-effect-mq-postgres'

const local = Schema.with(ZodAdapter)
class ImportOrderPayload extends local.Class<ImportOrderPayload>('app/ImportOrderPayload')({
  orderId: z.string(),
  lineIds: z.array(z.string())
}) {}
const importOrderPayloadCodec = Codec.standardSchema({
  schema: ImportOrderPayload,
  encode: (value) =>
    Schema.encode(ImportOrderPayload, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})

const Orders = Queue.define('orders')
const ImportOrder = Orders.job('import-order', {
  version: 1,
  payload: importOrderPayloadCodec,
  result: Codec.standardSchema({ schema: z.object({ completed: z.number().int() }) })
})
const ImportLine = Orders.job('import-line', {
  version: 1,
  payload: Codec.standardSchema({ schema: z.object({ lineId: z.string() }) }),
  result: Codec.standardSchema({ schema: z.string() })
})

const ImportFlow = Flow.define('import-order', {
  parent: ImportOrder,
  children: [ImportLine] as const,
  onChildFailure: 'fail'
})

const ImportFlowHandler = Flow.handle(ImportFlow, {
  fanOut: (payload) =>
    Effect.fn(async function* () {
      return Result.ok([
        Flow.children(
          ImportLine,
          payload.lineIds.map((lineId) => ({
            key: `line:${lineId}`,
            payload: { lineId }
          }))
        )
      ])
    }),
  collect: (_payload, results) =>
    Effect.fn(async function* () {
      return Result.ok({ completed: results.counts.completed } as const)
    })
})

const ImportLineHandler = Worker.handle(ImportLine, (payload) =>
  Effect.fn(async function* () {
    return Result.ok(`imported:${payload.lineId}`)
  })
)

const OrdersWorker = Worker.service('OrdersWorker')
const OrdersWorkerLive = OrdersWorker.layer(() => ({
  handlers: [ImportLineHandler] as const,
  flows: [ImportFlowHandler] as const,
  concurrency: 8,
  pollIntervalMs: 1_000,
  flowSweepIntervalMs: 5_000
}))

const flowStore = await PostgresFlowStore.make({
  pool,
  namespace: 'orders'
})

const AppLive = Layer.complete(
  Layer.merge(
    PostgresJobStore.layer({ pool, namespace: 'orders' }),
    Layer.succeed(FlowStore, FlowStore.of(flowStore)),
    ClockLive,
    OrdersWorkerLive
  )
)

const runtime = await Runtime.make(AppLive)
await runtime.warmup()

try {
  const completed = await runtime.run(() =>
    Effect.gen(async function* () {
      const payload = local.decodeUnknown(ImportOrderPayload, {
        orderId: 'order-42',
        lineIds: ['line-a', 'line-b', 'line-c']
      })
      if (Result.isError(payload)) throw payload.error
      const flowId = yield* ImportOrder.enqueue(payload.value)
      const result = yield* ImportOrder.awaitResult(flowId)
      return Result.ok({ flowId, result })
    })
  )
  if (Result.isError(completed)) throw completed.error
  console.log(completed.value)
} finally {
  await runtime.dispose()
  await flowStore.dispose()
  await pool.end()
}
```

The Worker executes the Flow phases and relays child outcomes through the
durable flow store. Child enqueue and relay across different JobStore tokens
remain at-least-once; deterministic child IDs, leases, and reconciliation make
replays safe. Use `FlowStore.for(MyJobs)` and a matching
`PostgresFlowStore.make` instance when parent and child Jobs use named stores.
Flow storage requires the flow schema extension; migrations run by
`PostgresMigrator` install it with the rest of the package schema.
The parent payload uses the schema-backed `ImportOrderPayload` class and an
explicit encoder; the child and aggregate result schemas stay concise because
their decoded values are already plain JSON.

## Outbox: transaction, record, publisher

Use the outbox when a domain write must reliably hand work to a Job. A direct
`domain INSERT` followed by `Job.enqueue` has a dual-write gap: the domain row
can commit while enqueue fails, or the Job can be accepted while the domain
write rolls back. `PostgresOutbox.transaction` owns the PostgreSQL transaction,
appends the prepared request after the domain callback succeeds, and commits
both writes together.

After commit, `OutboxPublisher` claims the record, resolves its target route,
enqueues the prepared Job, and marks the record published. The publisher is
post-commit work; it never holds the domain transaction open.

```text
domain transaction
  ├─ write order
  └─ append prepared outbox record
        │ COMMIT
        ▼
OutboxPublisher
  ├─ claim with a lease
  ├─ enqueue the routed Job
  └─ settle the record as published
        ▼
Worker.handle(SendConfirmation)
```

The following composition includes the durable JobStore, durable outbox,
publisher, and Worker. It then prepares a request, appends it beside a domain
write, and waits for the Worker to process the post-commit Job.

```ts
import * as z from 'zod'
import { Pool } from 'pg'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, JobEncodeFailure, JobStore, Queue, Worker } from 'better-effect-mq'
import { Schema } from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'
import { Result } from 'better-result'
import { OutboxId, OutboxPublisher, OutboxRoutes, makeOutboxRecord } from 'better-effect-mq-outbox'
import { PostgresJobStore, PostgresMigrator, PostgresOutbox } from 'better-effect-mq-postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const local = Schema.with(ZodAdapter)
class SendConfirmationPayload extends local.Class<SendConfirmationPayload>(
  'app/SendConfirmationPayload'
)({
  orderId: z.string(),
  email: z.email()
}) {}
const sendConfirmationPayloadCodec = Codec.standardSchema({
  schema: SendConfirmationPayload,
  encode: (value) =>
    Schema.encode(SendConfirmationPayload, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})
const Orders = Queue.define('orders')
const SendConfirmation = Orders.job('send-confirmation', {
  version: 1,
  payload: sendConfirmationPayloadCodec,
  result: Codec.standardSchema({ schema: z.string() }),
  idempotencyKey: (payload) => `confirmation:${payload.orderId}`
})

const SendConfirmationHandler = Worker.handle(SendConfirmation, (payload) =>
  Effect.fn(async function* () {
    console.log(`sending confirmation for ${payload.orderId} to ${payload.email}`)
    return Result.ok(`sent:${payload.orderId}`)
  })
)

const Routes = OutboxRoutes.make({ orders: JobStore })
const Publisher = OutboxPublisher.service('OrderOutboxPublisher')
const OrderWorker = Worker.service('OrderWorker')

const AppLive = Layer.complete(
  Layer.merge(
    PostgresJobStore.layer({ pool, namespace: 'orders' }),
    PostgresOutbox.layer({ pool, namespace: 'orders' }),
    ClockLive,
    OrderWorker.layer(() => ({
      handlers: [SendConfirmationHandler] as const,
      concurrency: 4,
      pollIntervalMs: 1_000
    })),
    Publisher.layer(() => ({
      outboxes: [PostgresOutbox] as const,
      routes: Routes,
      concurrency: 2,
      pollIntervalMs: 1_000
    }))
  )
)

await PostgresMigrator.run(pool, { schema: 'public' })
const runtime = await Runtime.make(AppLive)
await runtime.warmup()

try {
  const prepared = await runtime.run(() =>
    Effect.gen(async function* () {
      const payload = local.decodeUnknown(SendConfirmationPayload, {
        orderId: 'order-123',
        email: 'ada@example.test'
      })
      if (Result.isError(payload)) throw payload.error
      return Result.ok(
        yield* SendConfirmation.prepare(payload.value, { jobId: 'send-confirmation:order-123' })
      )
    })
  )
  if (Result.isError(prepared)) throw prepared.error

  const record = makeOutboxRecord({
    id: OutboxId.make('outbox:order-123').unwrap(),
    target: 'orders',
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
      const value = yield* SendConfirmation.awaitResult('send-confirmation:order-123')
      return Result.ok(value)
    })
  )
  if (Result.isError(completed)) throw completed.error
  console.log(completed.value)
} finally {
  await runtime.dispose()
  await pool.end()
}
```

`prepare` encodes the request before `transaction` acquires a client. The
adapter appends the record only after the callback succeeds, commits only
after that append succeeds, rolls back on thrown, rejected, or nominal
`Result.err` failures, and always releases the client. Reusing the same outbox
ID and request is digest-idempotent, while reusing an ID for a different
request is a conflict. Publishing is still at-least-once, so the Job handler
and any remote effect must tolerate retries. `PostgresOutbox.transaction`
receives a pool supplied by the application and owns the transaction client
lifecycle. `layerFromConfig` owns only the pool used by its provider Layer, so
use a caller-owned pool when domain code calls the static transaction helper.

### Advanced: caller-owned transactions

`PostgresOutbox.appendIn(transaction, record, options)` remains available as
an advanced escape hatch when an application already owns a compatible
transaction. It never begins, commits, rolls back, or releases that client;
the normal path should use `PostgresOutbox.transaction`.

## Named stores

The core API keeps store identity in the Job descriptor. Use a named token when
one Runtime serves independent queues:

```ts
import { Codec, JobStore, Queue } from 'better-effect-mq'
import { PostgresJobStore } from 'better-effect-mq-postgres'

const BillingJobs = JobStore.named('billing')
const Billing = Queue.define('billing')
const Charge = Billing.job('charge', {
  version: 1,
  payload: Codec.number,
  store: BillingJobs
})

const BillingLive = PostgresJobStore.layerFor(BillingJobs, {
  pool,
  namespace: 'billing'
})
```

Use corresponding associated tokens for extensions:
`JobEventStore.for(BillingJobs)`, `JobScheduleStore.for(BillingJobs)`, and
`FlowStore.for(BillingJobs)`. Named outboxes use
`PostgresOutbox.named('billing')` with `PostgresOutbox.layerFor(...)` and a
matching `outboxes` entry in the publisher options.

## Operational guarantees

- **Durability:** enqueue, claims, leases, settlement, retries, stalled-job
  recovery, and enabled extension records use PostgreSQL transactions.
- **Concurrency:** lease tokens and fencing prevent an old worker from
  settling a newer delivery. They cannot undo an external side effect.
- **Delivery:** work is at-least-once, not exactly-once. Use idempotency keys
  for external APIs and handlers.
- **Wake-ups:** event notifications accelerate polling but are not the source
  of truth. Keep bounded polling fallbacks enabled for waits.
- **Retention:** EventLog retention is finite and cursors can expire; it is
  not an infinite audit archive or a replacement for attempt records.
- **Transactions:** `transaction` atomically commits the domain callback and
  outbox append on one PostgreSQL client. It does not coordinate transactions
  across databases, pools, namespaces, or remote services.
- **Capacity:** PostgreSQL connection pools, locks, indexes, I/O, and queue
  depth still limit throughput. Increase worker concurrency only after
  measuring database and pool latency.

## Troubleshooting

### Layer acquisition reports an invalid schema

Run `PostgresMigrator.run(pool, { schema })` in the deploy step, then validate
with the same schema. Check that the Runtime connects to the intended database
and that the database user can read and update the schema.

### A Flow store cannot start

Flows require the flow extension installed by the current migrations. Upgrade
the schema before calling `PostgresFlowStore.make`; do not disable validation in
production to bypass the check.

### Jobs run more than once

This is expected after a crash or uncertain settlement under at-least-once
delivery. Use an explicit `jobId` or idempotency key for the external effect,
inspect the Job attempt ledger, and make sure the Worker lease and heartbeat
durations cover the handler's normal runtime.

### Events or waits appear stale

Confirm the JobStore and JobEventStore use the same pool, schema, namespace,
and Runtime. An EventLog wake is only a hint; use `pollFallbackMs` and inspect
the durable Job record. A retained-away cursor must be rebased.

### Outbox records remain active or pending

Confirm the publisher is in the same Runtime, its `outboxes` list contains the
token used by the adapter Layer, and its route target matches the record's
`target`. Recover stalled leases and inspect the publisher's retry or failure
state. The transaction helper only records the intent; it does not publish
the Job.

### The pool closes too early or never closes

`layer` borrows a caller-owned pool and never closes it. The host must call
`pool.end()` after Runtime shutdown. `layerFromConfig` owns its pool and closes
it during `runtime.dispose()`; do not call `pool.end()` for that pool.

## More information

- [`better-effect-mq`](../better-effect-mq) — the storage-neutral Job,
  Worker, EventLog, Flow, and schedule APIs.
- [`better-effect-mq-outbox`](../better-effect-mq-outbox) — outbox records,
  routes, and the publisher lifecycle.
- [MQ composition guide](../better-effect-mq/docs/composition.md) — shared
  Layer and Runtime patterns for adapters.
- [MQ examples](../better-effect-mq/examples/README.md) — runnable in-memory
  producer and Worker examples.

## Plain JSON escape hatch

When a payload is already a JSON-safe shape and validation happens elsewhere,
the core still provides `Codec.json<T>()`:

```ts
const AuditJob = Queue.define('audit').job('record', {
  version: 1,
  payload: Codec.json<{ readonly event: string }>()
})
```

Use a `better-effect-schema` provider at untrusted boundaries when the queue
should validate and decode data as part of the Job contract.
