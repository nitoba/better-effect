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
point before serving or publishing work.

This complete Bun example creates a file, applies the current migrations,
starts a Runtime, and enqueues one job:

```ts
import { Runtime, ServiceRuntime } from 'better-effect'
import { JobStore, makeQueueName } from 'better-effect-mq'
import { SqliteMigrator } from 'better-effect-mq-sqlite'
import { layerFromFile, openSqlite } from 'better-effect-mq-sqlite/bun'

const path = './data/jobs.sqlite'

// Run this once during application setup or deployment.
const database = openSqlite(path)
SqliteMigrator.migrate({ database })
database.close?.()

// The Layer owns this connection and closes it when the Runtime is disposed.
const runtime = await Runtime.make(layerFromFile({ path, namespace: 'my-app' }))

try {
  const result = await runtime.run(async () => {
    const jobs = await ServiceRuntime.resolve(JobStore)
    const now = Date.now()

    return jobs.enqueue({
      job: { queue: makeQueueName('emails').unwrap(), name: 'send-email', version: 1 },
      payload: { to: 'ada@example.test' },
      runAt: now,
      attemptsMax: 3,
      now
    })
  })

  if (result.isErr()) throw result.error
  console.log(`enqueued ${result.value.job.id}`)
} finally {
  await runtime.dispose()
}
```

`layerFromFile` validates the existing layout when the Layer starts; it does
not run migrations. Calling `migrate` again is safe and returns no newly
applied entries when the file is already current.

## Owning the database connection

Use the generic entrypoint when your application already opens SQLite, needs a
custom driver binding, or wants several Services to share one connection. The
caller owns the connection and closes it after the Runtime has been disposed:

```ts
import { Database } from 'bun:sqlite'
import { Layer, Runtime } from 'better-effect'
import { SqliteJobStore, SqliteMigrator } from 'better-effect-mq-sqlite'

const database = new Database('./data/jobs.sqlite')
SqliteMigrator.migrate({ database })

const AppLive = Layer.complete(SqliteJobStore.layer({ database, namespace: 'my-app' }))
const runtime = await Runtime.make(AppLive)

// Use JobStore through runtime.run(...).
await runtime.dispose()
database.close()
```

Use `:memory:` for isolated tests. It is scoped to one connection and is not
shared by opening the same name again.

## Compose the storage features

Each feature is an independent provider. Compose the providers into one
Runtime so producers, workers, schedulers, event readers, flow workers, and
outbox publishers resolve the same Services.

### Jobs and schedules

Schedules use the associated `JobStore` and should be provided beside it:

```ts
import { Database } from 'bun:sqlite'
import { Layer, Runtime } from 'better-effect'
import { SqliteJobScheduleStore, SqliteJobStore, SqliteMigrator } from 'better-effect-mq-sqlite'

const database = new Database(':memory:')
SqliteMigrator.migrate({ database })

const AppLive = Layer.complete(
  Layer.merge(
    SqliteJobStore.layer({ database, namespace: 'my-app' }),
    SqliteJobScheduleStore.layer({ database, namespace: 'my-app' })
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
import { Runtime } from 'better-effect'
import { SqliteJobStore, SqliteMigrator } from 'better-effect-mq-sqlite'

const database = new Database(':memory:')
SqliteMigrator.migrate({ database })

const runtime = await Runtime.make(
  SqliteJobStore.layerWithEvents(
    { database, namespace: 'my-app', pollIntervalMs: 1_000 },
    { retention: { count: 100_000 } }
  )
)
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
import { SqliteFlowStore, SqliteJobStore, SqliteMigrator } from 'better-effect-mq-sqlite'

const database = new Database(':memory:')
SqliteMigrator.migrate({ database })

const AppLive = Layer.complete(
  Layer.merge(
    SqliteJobStore.layer({ database, namespace: 'my-app' }),
    SqliteFlowStore.layer({ database, namespace: 'my-app' })
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
process restarts:

```ts
import { Database } from 'bun:sqlite'
import { Layer, Runtime } from 'better-effect'
import { SqliteJobStore, SqliteMigrator, SqliteOutboxStore } from 'better-effect-mq-sqlite'

const database = new Database(':memory:')
SqliteMigrator.migrate({ database })

const AppLive = Layer.complete(
  Layer.merge(
    SqliteJobStore.layer({ database, namespace: 'my-app' }),
    SqliteOutboxStore.layer({ database, namespace: 'my-app' })
  )
)

const runtime = await Runtime.make(AppLive)
```

The outbox is at-least-once. Publishing and marking a row published are
separate steps, so the downstream operation must tolerate redelivery. For a
named outbox, use `OutboxStore.named('billing')` with
`SqliteOutboxStore.layerFor(...)`.

### One Runtime with every extension

For an application using all available SQLite features, the composition root
can stay small:

```ts
import { Database } from 'bun:sqlite'
import { Layer, Runtime } from 'better-effect'
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
    SqliteJobStore.layerWithEvents(
      { database, namespace: 'my-app', pollIntervalMs: 1_000 },
      { retention: { count: 100_000 } }
    ),
    SqliteJobScheduleStore.layer({ database, namespace: 'my-app' }),
    SqliteFlowStore.layer({ database, namespace: 'my-app' }),
    SqliteOutboxStore.layer({ database, namespace: 'my-app' })
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
- `SqliteOutboxTransactions.appendIn` for an existing caller-owned SQLite
  write context;
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

`SqliteOutboxTransactions.appendIn(database, input, options)` inserts an
outbox record using the supplied SQLite connection and does not own that
connection. The caller decides when the surrounding write context commits or
rolls back. `options.namespace` defaults to `default`; use the same namespace
as the corresponding outbox Layer.

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
