# better-effect-mq-outbox

Durable outbox building blocks for [`better-effect-mq`](../better-effect-mq).
The package lets an application commit a domain change and the job that must
follow it as one database transaction. A Runtime-owned publisher then moves
the committed work to a `JobStore` in the background.

The package is storage-neutral. Database adapters provide the durable
`OutboxStore` implementation and own the transaction boundary for their own
database type. The normal application-facing boundary is
`adapter.transaction(resource, preparedRecord, callback, options?)`: the
adapter runs the domain callback, appends the supplied record, and owns commit,
rollback, and cleanup. Jobs and Workers remain the application-facing API from
`better-effect-mq`; the publisher is a bridge from a durable outbox to a typed
Job descriptor.

## Why use an outbox?

Suppose an order service must save an order and send a confirmation email. If
the service commits the order and then calls a queue, there are two writes
with no shared atomic boundary:

- the order can commit while the queue call fails, leaving no email to send;
- the queue can accept the email while the order transaction rolls back,
  leaving a job that refers to data that does not exist.

That is the dual-write problem. An outbox gives the two writes one durable
transaction:

1. write the domain rows;
2. write an `OutboxRecord` describing the job;
3. commit once.

If the transaction rolls back, neither write is visible. If it commits, the
record remains available until a publisher delivers it, even if the process
crashes immediately afterwards.

An outbox is useful when a database transaction is the source of truth and a
job, notification, webhook, or other asynchronous action must reliably follow
that transaction. It is usually unnecessary for best-effort telemetry or when
the receiving system already participates in the same transaction. An outbox
also does not make a database and a remote service one distributed
transaction; it makes the handoff durable and recoverable.

## The post-commit flow

`adapter.transaction(resource, preparedRecord, callback, options?)` runs the
domain write and outbox append as one unit. The adapter appends the supplied
record after the domain callback succeeds, then commits; the publisher only
handles work after that transaction commits:

```text
adapter.transaction(resource, preparedRecord, callback, options?)
  ├─ domain write
  ├─ automatic outbox append
  └─ commit
        │
        ▼
OutboxPublisher
  ├─ claim a record with a lease
  ├─ resolve its target through OutboxRoutes
  ├─ enqueue the prepared request in the JobStore
  └─ mark the record published
```

The publisher never holds the application transaction open while it talks to
the `JobStore`. It renews leases while work is in flight, and another publisher
can recover a record whose lease expires.

## Core concepts

### `OutboxRecord`

An `OutboxRecord` is the immutable, persisted description of one future job.
It contains:

- an application-chosen `OutboxId`;
- a string `target`, which is looked up in `OutboxRoutes`;
- the already prepared job request;
- the attempt budget and schedule; and
- the delivery state and failure information maintained by the store.

Create it from `Job.prepare`, not from a live codec, callback, Service,
Runtime, connection, or transaction. `Job.prepare` produces a JSON-safe,
immutable request that can cross the persistence boundary. `makeOutboxRecord`
validates the complete record and returns a `Result`.

The same `OutboxId` and the same request can be appended repeatedly; the store
acknowledges the duplicate. Reusing an ID for a different request returns an
`OutboxConflictError`. This makes transaction retries safe when the application
uses a deterministic outbox ID.

### `OutboxStore`

`OutboxStore` is the storage contract behind the publisher. It is responsible
for claiming, lease heartbeats, settlement, stalled-lease recovery, and
inspection (`get`, `list`, and `counts`). A claim returns a lease token; only
the holder of that token can settle the record. The core contract intentionally
does not define a transaction handle. Each durable adapter owns its transaction
lifecycle and exposes `transaction(resource, preparedRecord, callback, options?)`;
the helper supplies the adapter-specific resource to the domain callback and
automatically appends the supplied record after that callback succeeds.

The core package exports `MemoryOutboxStore` for tests and examples. It is not
durable and must not be used as a cross-process queue. PostgreSQL, SQLite, and
other integrations provide durable stores and their own transaction helper.

Use a named token when one Runtime contains more than one independent outbox:

```ts
import { OutboxStore } from 'better-effect-mq-outbox'

const ApplicationOutbox = OutboxStore.named('application')
```

The adapter layer must provide the token selected by the application. Named
tokens keep unrelated outbox tables or namespaces separate.

### `OutboxRoutes`

`OutboxRoutes` is the routing table from the record's `target` to a concrete
`JobStore` Service token:

```ts
import { JobStore } from 'better-effect-mq'
import { OutboxRoutes } from 'better-effect-mq-outbox'

const Routes = OutboxRoutes.make({
  jobs: JobStore
})
```

#### Advanced routing: named `JobStore` tokens

This is a token map, not a map of store instances: `JobStore` selects the
default store, while `JobStore.named('billing')` selects a named store. The
record stores only the string target (`'jobs'` here); the publisher resolves
that target to the token through `OutboxRoutes` inside the Runtime. Use
`OutboxRoutes.make` only when a publisher needs to route records to a specific
JobStore, especially when one Runtime contains multiple named stores.

The target stored in a record must exactly match a route. Route targets must be
unique; duplicate entries are rejected. An absent route is reported as an
`OutboxRouteMissingError`, remains visible in the outbox, and consumes the
configured retry budget instead of disappearing silently.

### `OutboxPublisher`

`OutboxPublisher.service()` creates a Service token whose Layer owns the
publisher lifecycle. It claims records, validates their prepared requests,
enqueues them in the selected `JobStore`, and settles them only after the
`JobStore` confirms the enqueue.

```ts
import { OutboxPublisher } from 'better-effect-mq-outbox'

const Publisher = OutboxPublisher.service('OrderOutboxPublisher')
const PublisherLive = Publisher.layer(() => ({
  outboxes: [ApplicationOutbox] as const,
  routes: Routes,
  concurrency: 4,
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 1_000
}))
```

The publisher uses bounded exponential backoff for retryable failures. Invalid
requests, permanent failures, and records that exhaust `attemptsMax` become
`failed` with a serialized failure that can be inspected. `onError` and the
optional observer are process-local diagnostics; they do not replace durable
outbox state.

The publisher is started when its Layer is acquired and stopped by Runtime
shutdown. `Runtime.dispose()` first quiesces new claims, lets admitted work
finish, and then closes the publisher and its stores.

## End-to-end example with PostgreSQL

The following example uses the PostgreSQL adapter as a concrete durable
`JobStore` and `OutboxStore`. The same shape applies to another adapter: run
its migrations and use its durable layers. The adapter's transaction helper is
the application boundary for a domain write and its outbox append.

This example uses a native Zod 4 schema so the payload is validated before it
becomes a prepared request. When a job also needs provider-backed classes or
transport conversions, use `better-effect-schema` as shown in the [MQ codec
example](../better-effect-schema/examples/mq-codec.ts). Install the optional
schema integration alongside the queue and adapter packages when your job
crosses an untrusted boundary:

```sh
bun add better-effect-mq-outbox better-effect-mq-postgres better-effect-mq better-effect better-result better-effect-schema zod
```

The database pool below is caller-owned. It could be a `pg.Pool` created by
your application:

```ts
import * as z from 'zod'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, JobStore, Queue, Worker } from 'better-effect-mq'
import { Result } from 'better-result'
import { OutboxId, OutboxPublisher, OutboxRoutes, makeOutboxRecord } from 'better-effect-mq-outbox'
import {
  PostgresJobStore,
  PostgresMigrator,
  PostgresOutbox,
  type Pool
} from 'better-effect-mq-postgres'

declare const pool: Pool

const ConfirmationPayload = z.object({
  orderId: z.string().min(1),
  email: z.email()
})

// Run this during deployment or an explicit startup step, before the layers
// validate the schema.
await PostgresMigrator.run(pool)

const SendConfirmation = Queue.define('orders').job('send-confirmation', {
  version: 1,
  payload: Codec.standardSchema({ schema: ConfirmationPayload }),
  result: Codec.string,
  defaults: { attempts: 5 },
  idempotencyKey: (payload) => `order-confirmation:${payload.orderId}`
})

const ConfirmationWorker = Worker.service('@orders/ConfirmationWorker')
const confirmationHandler = Worker.handle(SendConfirmation, (payload) =>
  Effect.fn(async function* () {
    return Result.ok(`sent:${payload.email}`)
  })
)
const ConfirmationWorkerLive = ConfirmationWorker.layer(() => ({
  handlers: [confirmationHandler] as const,
  concurrency: 2,
  pollIntervalMs: 100
}))

const Routes = OutboxRoutes.make({
  jobs: JobStore
})
const Publisher = OutboxPublisher.service('OrderOutboxPublisher')

const PublisherLive = Publisher.layer(() => ({
  // PostgresOutbox is the durable adapter token used by this example.
  outboxes: [PostgresOutbox] as const,
  routes: Routes,
  concurrency: 2,
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 100
}))

const AppLive = Layer.complete(
  Layer.merge(
    Layer.merge(
      PostgresJobStore.layer({ pool, namespace: 'orders' }),
      PostgresOutbox.layer({ pool, namespace: 'orders' })
    ),
    Layer.merge(ClockLive, Layer.merge(ConfirmationWorkerLive, PublisherLive))
  )
)

const runtime = await Runtime.make(AppLive)
await runtime.warmup()
```

Prepare the job before opening the application transaction. The request is
now fully encoded and can be stored safely:

```ts
const preparedResult = await runtime.run(() =>
  Effect.gen(async function* () {
    const prepared = yield* SendConfirmation.prepare(
      {
        orderId: 'order-123',
        email: 'ada@example.test'
      },
      { jobId: 'order-confirmation:order-123' }
    )
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
```

Call the adapter's normal transaction boundary with the resource, prepared
record, domain callback, and optional adapter settings. The callback performs
only the domain write; the adapter appends `record.value` automatically:

```ts
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

`adapter.transaction(resource, preparedRecord, callback, options?)`

The callback performs the domain write. After it succeeds, the adapter
automatically appends the supplied `preparedRecord`, and commits only after
both operations succeed. A thrown or rejected callback, a failed append, or a
domain `Result.err` rolls the transaction back before the adapter cleans up or
releases its resource. The core package deliberately does not expose a
cross-database transaction context; the adapter owns that context and its
lifecycle.

After the callback commits, the running publisher claims the record and calls
the `jobs` route. The `JobStore` receives the prepared request and the outbox
record is marked `published` only after that enqueue succeeds. The Worker then
handles the typed `SendConfirmation` job. Keep the Runtime alive for the
lifetime of the application and dispose it during graceful shutdown:

```ts
// ...serve requests while `runtime` is alive...
const completed = await runtime.run(() =>
  Effect.gen(async function* () {
    return Result.ok(yield* SendConfirmation.awaitResult('order-confirmation:order-123'))
  })
)
if (Result.isError(completed)) throw completed.error
await runtime.dispose()
await pool.end?.() // the application owns this pool
```

If the pool should be created and closed by the Runtime instead, use
`PostgresJobStore.layerFromConfig({ connectionString, ... })` and
`PostgresOutbox.layerFromConfig({ connectionString, ... })`. Do not call
`pool.end()` for a pool owned by those Layers.

## Delivery guarantees and failure handling

### At-least-once delivery

Delivery is at-least-once, not exactly-once. A crash or lost response after the
`JobStore` accepted the job but before the outbox settlement is durable can
cause the same prepared request to be enqueued again. The publisher treats a
duplicate enqueue as success, but it cannot undo an external side effect that
already happened.

Choose a deterministic `jobId` or `idempotencyKey` when preparing a request.
Make the job handler idempotent too: use the job ID or an application key when
writing an external record, sending a notification, or calling a remote API.
Idempotency belongs at both boundaries—the enqueue operation and the handler's
side effects.

### Retries, leases, and failures

Retryable store errors, missing routes, and uncertain settlement are retried
with exponential backoff until the record's attempt budget is exhausted.
Permanent or invalid data is recorded as a failure. A worker that stops
renewing its lease does not permanently own the record: the store can recover
it after expiry, and another publisher can try it. Lease tokens fence an old
worker from settling a newer attempt.

Inspect failed records and their failure kind/message before deciding how to
repair or redrive them. A route configuration error should be fixed before
redriving; increasing retries does not make an invalid request valid.

## Transaction ownership

The core package has no database connection or transaction API. Each durable
adapter must expose the normal boundary
`adapter.transaction(resource, preparedRecord, callback, options?)`. The
application supplies the resource, prepared record, and callback for its
domain write; the adapter uses its transaction context to append that record
automatically after the callback succeeds, then owns commit, rollback, and
cleanup.

Every adapter transaction helper must provide the same guarantees:

1. invoke the domain callback within the adapter's transaction context;
2. append the supplied `preparedRecord` in that same transaction after the
   callback succeeds;
3. treat a thrown or rejected callback, an append failure, or a domain
   `Result.err` as failure and roll back;
4. commit only after both operations succeed; and
5. release or end every adapter resource on both success and failure, while
   preserving the original domain or append failure if cleanup also fails.

This transaction helper is the primary application-facing API.

### Advanced: caller-owned transactions

An adapter may retain `appendIn` as an explicitly advanced escape hatch for integrations that
already own a transaction, but that low-level helper must not be the normal
guide or require application code to manage lifecycle. The publisher's
post-commit operations use the adapter's regular store lifecycle and never
hold an application transaction while delivering a job.

The public adapter contract is intentionally adapter-specific:

| Adapter    | Required `transaction` behavior                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL | Run the domain callback in the adapter's typed query context, append the supplied record automatically, and own the resource lifecycle.                                              |
| MySQL      | Run the domain callback in the adapter's typed query context, append the supplied record automatically, and own the resource lifecycle.                                              |
| MongoDB    | Run the domain callback in the adapter's typed session context, append the supplied record automatically, and own the resource lifecycle.                                            |
| SQLite     | Run the domain callback through the adapter's serialized transaction resource, append the supplied record automatically, and own cleanup.                                            |
| Redis      | Run Redis-native domain commands in the adapter's `MULTI` context, append the supplied record automatically, and own `EXEC`/discard cleanup; this does not include another database. |

Each adapter worker should add type-safe runtime and type-level coverage for
transaction success, domain failure, append failure, rollback, commit,
cleanup/release, and the absence of leaked connections or sessions. Reuse the
core outbox conformance suite for post-commit behavior; transaction tests
belong beside the adapter because only it knows the adapter resource and
lifecycle.

## Testing and implementing an adapter

Use `MemoryOutboxStore` for fast unit tests, or import the runner-agnostic
contract suite from `better-effect-mq-outbox/testing` when implementing a
durable adapter:

```ts
import { MemoryOutboxStore } from 'better-effect-mq-outbox'
import { outboxStoreContract } from 'better-effect-mq-outbox/testing'

const scenarios = outboxStoreContract({
  makeOutboxStore: () => MemoryOutboxStore.make(),
  clock: () => {
    let current = 0
    return {
      now: () => current,
      advance: (milliseconds: number) => {
        current += milliseconds
      }
    }
  }
})

for (const scenario of scenarios) await scenario.run()
```

The suite covers idempotent append and conflicts, ordering, leases and
fencing, heartbeat and recovery, settlement, retries, inspection, and named
outbox isolation. Adapter implementers should additionally test their
`transaction(resource, preparedRecord, callback, options?)` boundary: the
callback performs only the domain write, the helper appends the supplied
record automatically, and both operations commit or roll back together. Also
verify that resource ownership matches the Layer form they expose.
