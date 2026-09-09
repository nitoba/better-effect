# better-effect-mq-sqlite

Embedded SQLite storage for [`better-effect-mq`](../better-effect-mq). It keeps
jobs, schedules, durable job events, flows, and outbox records in a local
SQLite database while exposing the same Layer-first Services as the other
`better-effect-mq` adapters.

## Is SQLite the right choice?

SQLite is a strong default when the queue belongs with one application or one
machine:

- command-line tools and desktop applications;
- single-node services and local background workers;
- development, integration tests, and durable test fixtures;
- low-to-moderate queue volume where simple file operations are valuable.

Choose PostgreSQL, Redis, or another distributed adapter when you need several
hosts to write the same queue, high write concurrency, a managed service,
horizontal broker capacity, or operation over a network filesystem. SQLite
supports concurrent readers, but writes are serialized by the database file.
That makes it durable and predictable, not a replacement for a multi-host
broker.

The adapter provides durable state and at-least-once delivery semantics. A
worker crash can leave work to be retried, so handlers and publishers should
be safe to run again. Queue coordination is local to the SQLite file; the
application still owns process supervision, file permissions, disk capacity,
and backups.

## Installation

Install the adapter together with the core packages:

```sh
bun add better-effect-mq-sqlite better-effect-mq better-effect better-result
```

The package deliberately does not choose a SQLite driver for the generic
entrypoint. Pick the host binding that matches your runtime:

### Bun

Bun includes `bun:sqlite`, so no additional SQLite driver is needed:

```ts
import { openSqlite } from 'better-effect-mq-sqlite/bun'

const database = openSqlite('./data/jobs.sqlite')
```

### Node.js

The Node subpath uses Node's built-in `node:sqlite` binding. Use a current
Node.js release that provides it; when the binding is still marked experimental
in your release, run Node with `--experimental-sqlite`.

```ts
import { openSqlite } from 'better-effect-mq-sqlite/node'

const database = openSqlite('./data/jobs.sqlite')
```

The generic `better-effect-mq-sqlite` entrypoint never imports either host
binding. It accepts any database object implementing the small structural
interface described in [Advanced reference](#advanced-reference).

## Quick start: one local file

The host-specific `layerFromFile` opens and closes the database with the
Runtime. Migrations remain explicit, so deployment can run them at a deliberate
point before serving or publishing work. Jobs and workers still come from
`better-effect-mq`; SQLite only supplies the durable `JobStore`.

This complete Bun example creates a file, applies the current migrations,
starts a Runtime-owned Worker, and waits for one typed job:

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, Queue, Worker } from 'better-effect-mq'
import { SqliteMigrator } from 'better-effect-mq-sqlite'
import { layerFromFile, openSqlite } from 'better-effect-mq-sqlite/bun'
import { Result } from 'better-result'

const path = './data/jobs.sqlite'

// Run this once during application setup or deployment.
const migrationDatabase = openSqlite(path)
try {
  SqliteMigrator.migrate({ database: migrationDatabase })
} finally {
  migrationDatabase.close?.()
}

const Emails = Queue.define('emails')
const SendEmail = Emails.job('send-email', {
  version: 1,
  payload: Codec.json<{
    readonly recipient: string
  }>(),
  result: Codec.string
})

const EmailWorker = Worker.service('@app/EmailWorker')
const emailHandler = Worker.handle(SendEmail, (payload) =>
  Effect.fn(async function* () {
    return Result.ok(`sent:${payload.recipient}`)
  })
)
const EmailWorkerLive = EmailWorker.layer(() => ({
  handlers: [emailHandler] as const,
  concurrency: 1,
  pollIntervalMs: 100
}))

// The Layer owns this connection and closes it when the Runtime is disposed.
const AppLive = Layer.complete(
  Layer.merge(layerFromFile({ path, namespace: 'my-app' }), Layer.merge(ClockLive, EmailWorkerLive))
)
const runtime = await Runtime.make(AppLive)

try {
  const started = await runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* EmailWorker)
    })
  )
  if (Result.isError(started)) throw started.error

  const result = await runtime.run(() =>
    Effect.gen(async function* () {
      const jobId = yield* SendEmail.enqueue({ recipient: 'ada@example.test' })
      const completed = yield* SendEmail.awaitResult(jobId)
      return Result.ok({ jobId, completed })
    })
  )
  if (Result.isError(result)) throw result.error

  console.log(result.value)
  await started.value.awaitIdle()
} finally {
  await runtime.dispose()
}
```

`layerFromFile` validates the existing layout when the Layer starts; it does
not run migrations. Calling `migrate` again is safe and returns no newly
applied entries when the file is already current.

## Owning the database connection

Use the generic entrypoint when your application already opens SQLite, needs a
custom driver binding, or wants several Services to share one connection. Keep
the `SendEmail` descriptor and `EmailWorkerLive` from the Quick Start; only the
storage provider changes. The caller owns the connection and closes it after
the Runtime has been disposed:

```ts
import { Database } from 'bun:sqlite'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import { SqliteJobStore, SqliteMigrator } from 'better-effect-mq-sqlite'

const database = new Database('./data/jobs.sqlite')
SqliteMigrator.migrate({ database })

const AppLive = Layer.complete(
  Layer.merge(
    SqliteJobStore.layer({ database, namespace: 'my-app' }),
    Layer.merge(ClockLive, EmailWorkerLive)
  )
)
const runtime = await Runtime.make(AppLive)

try {
  const result = await runtime.run(() =>
    Effect.gen(async function* () {
      const jobId = yield* SendEmail.enqueue({ recipient: 'ada@example.test' })
      return Result.ok(jobId)
    })
  )
  if (Result.isError(result)) throw result.error
} finally {
  await runtime.dispose()
  database.close()
}
```

Use `:memory:` for isolated tests. It is scoped to one connection and is not
shared by opening the same name again.

## Compose the storage features

Each feature is an independent provider. Compose the providers into the same
Runtime as the `SendEmail` descriptor and `EmailWorkerLive` from the Quick
Start so producers, workers, schedulers, event readers, flow workers, and
outbox publishers use the same Services. The snippets below intentionally reuse
those declarations; they show the provider change, not a second job API.

### Jobs and schedules

Schedules use the associated `JobStore` and should be provided beside it:

```ts
import { Database } from 'bun:sqlite'
import { Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { SqliteJobScheduleStore, SqliteJobStore, SqliteMigrator } from 'better-effect-mq-sqlite'

const database = new Database(':memory:')
SqliteMigrator.migrate({ database })

const AppLive = Layer.complete(
  Layer.merge(
    Layer.merge(
      SqliteJobStore.layer({ database, namespace: 'my-app' }),
      SqliteJobScheduleStore.layer({ database, namespace: 'my-app' })
    ),
    Layer.merge(ClockLive, EmailWorkerLive)
  )
)

const runtime = await Runtime.make(AppLive)
```

For multiple independent queues in the same process, create a named
`JobStore` with `JobStore.named('billing')`, then derive its schedule token
with `JobScheduleStore.for(billingStore)`. Use `layerFor` for both providers;
the [advanced reference](#advanced-reference) lists the exact forms.

### Durable job events

Events are opt-in. `layerWithEvents` provides the `JobStore` and its matching
`JobEventStore` together:

```ts
import { Database } from 'bun:sqlite'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { JobEventStore } from 'better-effect-mq'
import { SqliteJobStore, SqliteMigrator } from 'better-effect-mq-sqlite'
import { Result } from 'better-result'

const database = new Database(':memory:')
SqliteMigrator.migrate({ database })

const AppLive = Layer.complete(
  Layer.merge(
    SqliteJobStore.layerWithEvents(
      { database, namespace: 'my-app', pollIntervalMs: 1_000 },
      { retention: { count: 100_000 } }
    ),
    Layer.merge(ClockLive, EmailWorkerLive)
  )
)
const runtime = await Runtime.make(AppLive)

const result = await runtime.run(() =>
  Effect.gen(async function* () {
    const jobId = yield* SendEmail.enqueue({ recipient: 'ada@example.test' })
    const completed = yield* SendEmail.awaitResult(jobId, {
      strategy: 'events',
      eventStore: JobEventStore,
      pollFallbackMs: 5_000
    })
    return Result.ok({ jobId, completed })
  })
)
if (Result.isError(result)) throw result.error
await runtime.dispose()
```

Use the event token from `better-effect-mq` with `Job.awaitResult` or
`JobEvents.page`/`JobEvents.forEach`. Events are a bounded operational feed,
not an archive: retention can expire old cursors, and event records intentionally
avoid copying payloads, results, complete failures, or arbitrary metadata.

### Flows

Add the flow provider when the application registers flow routes with the
`better-effect-mq` Worker:

```ts
import { Database } from 'bun:sqlite'
import { Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { SqliteFlowStore, SqliteJobStore, SqliteMigrator } from 'better-effect-mq-sqlite'

const database = new Database(':memory:')
SqliteMigrator.migrate({ database })

const AppLive = Layer.complete(
  Layer.merge(
    Layer.merge(
      SqliteJobStore.layer({ database, namespace: 'my-app' }),
      SqliteFlowStore.layer({ database, namespace: 'my-app' })
    ),
    Layer.merge(ClockLive, EmailWorkerLive)
  )
)

const runtime = await Runtime.make(AppLive)
```

The flow layer persists parent/child state and durable child reports. The
Worker still owns enqueueing child jobs and relaying reports between the
associated store Services; SQLite does not make separate store keys or
separate databases one atomic boundary.

### Durable outbox

Provide an outbox layer beside the JobStore when a publisher should survive
process restarts. The transaction helper owns SQLite serialization and the
transaction lifecycle. Its callback only performs the domain write; the
adapter appends the prepared outbox record after the callback succeeds:

```ts
import { Database } from 'bun:sqlite'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, JobStore, Queue, Worker } from 'better-effect-mq'
import {
  OutboxId,
  OutboxPublisher,
  OutboxRoutes,
  OutboxStore,
  makeOutboxRecord
} from 'better-effect-mq-outbox'
import {
  SqliteJobStore,
  SqliteMigrator,
  SqliteOutboxStore,
  SqliteOutboxTransactions
} from 'better-effect-mq-sqlite'
import { Result } from 'better-result'

const Orders = Queue.define('orders')
const SendConfirmation = Orders.job('send-confirmation', {
  version: 1,
  payload: Codec.json<{
    readonly orderId: string
    readonly email: string
  }>(),
  result: Codec.string
})

const ConfirmationWorker = Worker.service('@app/ConfirmationWorker')
const confirmationHandler = Worker.handle(SendConfirmation, (payload) =>
  Effect.fn(async function* () {
    return Result.ok(`sent:${payload.email}`)
  })
)
const ConfirmationWorkerLive = ConfirmationWorker.layer(() => ({
  handlers: [confirmationHandler] as const,
  concurrency: 1,
  pollIntervalMs: 100
}))

const Routes = OutboxRoutes.make({ jobs: JobStore })
const Publisher = OutboxPublisher.service('@app/OutboxPublisher')
const PublisherLive = Publisher.layer(() => ({
  outboxes: [OutboxStore] as const,
  routes: Routes,
  concurrency: 1,
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 100
}))

const database = new Database(':memory:')
SqliteMigrator.migrate({ database })
database.exec('CREATE TABLE orders (id TEXT PRIMARY KEY, email TEXT NOT NULL)')

const AppLive = Layer.complete(
  Layer.merge(
    Layer.merge(
      SqliteJobStore.layer({ database, namespace: 'my-app' }),
      SqliteOutboxStore.layer({ database, namespace: 'my-app' })
    ),
    Layer.merge(ClockLive, Layer.merge(ConfirmationWorkerLive, PublisherLive))
  )
)

const runtime = await Runtime.make(AppLive)

const prepared = await runtime.run(() =>
  Effect.gen(async function* () {
    const request = yield* SendConfirmation.prepare(
      { orderId: 'order-1', email: 'ada@example.test' },
      { jobId: 'order-confirmation:order-1' }
    )
    return Result.ok(request)
  })
)
if (Result.isError(prepared)) throw prepared.error

const outboxRecord = makeOutboxRecord({
  id: OutboxId.make('order-confirmation:order-1').unwrap(),
  target: 'jobs',
  request: prepared.value,
  attemptsMax: 5
}).unwrap()

const committed = await SqliteOutboxTransactions.transaction(
  database,
  outboxRecord,
  (transaction) => {
    transaction
      .prepare('INSERT INTO orders(id, email) VALUES (?, ?)')
      .run('order-1', 'ada@example.test')
    return Result.ok('order-1')
  },
  { namespace: 'my-app' }
)
if (Result.isError(committed)) throw committed.error
console.log(`saved ${committed.value}`)
await runtime.dispose()
database.close()
```

The outbox is at-least-once. Publishing and marking a row published are
separate steps, so the downstream operation must tolerate redelivery. For a
named outbox, use `OutboxStore.named('billing')` with
`SqliteOutboxStore.layerFor(...)`. If the domain callback returns
`Result.err(error)`, throws, or rejects, both the domain write and outbox
append are rolled back. An append conflict or validation failure is returned
as a `Result.err` and also rolls back the domain write.

### One Runtime with every extension

For an application using all available SQLite features, the composition root
can stay small:

```ts
import { Database } from 'bun:sqlite'
import { Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import {
  SqliteFlowStore,
  SqliteJobScheduleStore,
  SqliteJobStore,
  SqliteMigrator,
  SqliteOutboxStore
} from 'better-effect-mq-sqlite'

const database = new Database(':memory:')
SqliteMigrator.migrate({ database })

const AppLive = Layer.complete(
  Layer.merge(
    Layer.merge(
      SqliteJobStore.layerWithEvents(
        { database, namespace: 'my-app', pollIntervalMs: 1_000 },
        { retention: { count: 100_000 } }
      ),
      Layer.merge(
        SqliteJobScheduleStore.layer({ database, namespace: 'my-app' }),
        Layer.merge(
          SqliteFlowStore.layer({ database, namespace: 'my-app' }),
          SqliteOutboxStore.layer({ database, namespace: 'my-app' })
        )
      )
    ),
    Layer.merge(ClockLive, EmailWorkerLive)
  )
)

const runtime = await Runtime.make(AppLive)
```

Migrate the database before creating this Runtime. All providers should use
the same file and namespace when they are meant to participate in one local
application; use different namespaces for intentional isolation.

## Concurrency and operational limits

SQLite is a single-file database with one writer at a time. In practice:

- readers can proceed concurrently;
- short queue operations coordinate correctly across processes on the same
  machine;
- a busy writer waits for a bounded period and then reports the failure;
- wakeups from another local process are discovered through polling, so a
  worker should retain a sensible poll interval;
- the worker handler is not part of the database operation, so slow handlers
  do not hold the queue's write slot.

For a caller-owned connection, keep the queue on local durable storage and
choose a namespace per logical store. If write contention is expected, size a
finite busy timeout and a sensible polling interval rather than relying on
unbounded retries.
The defaults are a `default` namespace, a 5-second busy timeout, polling every
1 second, and schema validation enabled. The host-specific file Layers choose
connection configuration suitable for a local file and own the connection
lifecycle.

Do not place a live queue on NFS or another network filesystem. If several
machines need to claim from one queue, or if write contention becomes a
recurring operational problem, move to PostgreSQL or Redis rather than
increasing timeouts indefinitely.

## Migrations and backups

Migrations are explicit and idempotent:

```ts
import { SqliteMigrator } from 'better-effect-mq-sqlite'

const result = SqliteMigrator.migrate({ database })
console.log(result.applied)
```

Run migrations before starting producers, workers, schedulers, or publishers.
The Layers validate the existing layout at startup and do not silently change
it. Back up a file before a migration that changes its layout, and retain a
copy of the previous application version when you need a quick rollback plan.

For a cold backup, stop new work, await `runtime.dispose()`, close any
caller-owned connection, and copy the database file. For a hot backup, use the
backup API supplied by the host SQLite binding; do not assume that copying a
live file is a consistent snapshot. Restore into a separate path, run
`SqliteMigrator.validate(restoredDatabase)`, and exercise a read-only startup
before promoting it.

Keep the database on local durable storage with restricted file permissions,
monitor free disk space, and include the database in the application's restore
and retention policy. `:memory:` databases are test fixtures, not backups.

## Advanced reference

### Generic entrypoint

`better-effect-mq-sqlite` exports:

- `SqliteMigrator.migrate` and `SqliteMigrator.validate` (plus the `migrate`
  alias);
- `SqliteJobStore.make`, `.layer`, `.layerFor`, `.layerWithEvents`, and
  `.layerWithEventsFor`;
- `SqliteJobScheduleStore.make`, `.layer`, and `.layerFor`;
- `SqliteJobEventStore.make`, `.layer`, and `.layerFor`;
- `SqliteFlowStore.make`, `.layer`, and `.layerFor`;
- `SqliteOutboxStore` (also available as `SqliteOutbox`) with `.make`,
  `.appendIn`, `.layer`, and `.layerFor`;
- `SqliteOutboxTransactions.transaction(database, record, callback, options?)`
  for the normal domain-write-plus-outbox path;
- `SqliteOutboxTransactions.appendIn` for an existing caller-owned SQLite
  write context as an advanced escape hatch;
- `SqliteClient`, the structural `SqliteDatabase`/`SqliteStatement` types,
  configuration types, migration result types, and adapter errors. The
  caller-owned configuration also exposes `busyTimeoutMs`, `pollIntervalMs`,
  `configurePragmas`, and `validateSchema`.

`SqliteJobStore.layerWithEvents` is the convenient combined provider. If the
event Service needs to be configured separately, use `SqliteJobEventStore.layer`
or `.layerFor` with the matching `JobEventStore` token.

### Host subpaths

Both `better-effect-mq-sqlite/bun` and `better-effect-mq-sqlite/node` export:

- `openSqlite(path)`;
- `layerFromFile` and `layerFromFileFor` for a JobStore;
- `flowLayerFromFile` and `flowLayerFromFileFor` for a FlowStore;
- `outboxLayerFromFile` and `outboxLayerFromFileFor` for an OutboxStore.

These file Layers own only the connection they open. A supplied `database`
passed to a generic Layer remains owned by the caller. There is intentionally
no host-specific schedule file Layer: use one caller-owned connection with
`SqliteJobScheduleStore.layer`/`.layerFor` when schedules are part of a shared
composition.

### Existing write contexts

Use `SqliteOutboxTransactions.transaction(database, record, callback, options?)`
for normal application writes. It serializes callbacks sharing one SQLite
connection, owns `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`, appends the record after
the callback returns a successful nominal `Result`, and always releases its
serialization slot. The callback receives the typed `SqliteDatabase` so it can
perform the domain write directly; it must not issue transaction-control SQL.

`SqliteOutboxTransactions.appendIn(database, input, options)` inserts an
outbox record using the supplied SQLite connection and does not own that
connection. The caller decides when the surrounding write context commits or
rolls back. Keep it for advanced integrations that already own the transaction
lifecycle. `options.namespace` defaults to `default`; use the same namespace as
the corresponding outbox Layer.

This is the low-level integration point for an application that must persist a
domain change and its outbox record together. It accepts the outbox input
shape from `better-effect-mq-outbox`; it does not serialize callbacks,
Services, Runtime values, or database handles into the record.

### Schema files and validation

The published package includes the numbered files under `migrations/` for
inspection and deployment tooling. The supported application-facing path is
`SqliteMigrator.migrate({ database })`, followed by Layer startup validation.
`SqliteMigrator.validate(database)` is useful in health checks and restore
verification; it never changes the database.

## Related packages

- [`better-effect-mq`](../better-effect-mq) — queue contracts, Jobs, Workers,
  schedules, events, and flows;
- [`better-effect-mq-outbox`](../better-effect-mq-outbox) — storage-neutral
  outbox records, routes, and publisher;
- [`better-effect-mq-postgres`](../better-effect-mq-postgres) — choose this for
  multi-host relational deployments;
- [`better-effect-mq-redis`](../better-effect-mq-redis) — choose this for a
  distributed Redis/Valkey deployment.
