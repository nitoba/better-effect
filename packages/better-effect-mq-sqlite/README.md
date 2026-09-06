# better-effect-mq-sqlite

Optional embedded SQLite implementation of the `better-effect-mq` protocol-v1 `JobStore`,
`JobScheduleStore`, and `better-effect-mq-outbox` contracts.

SQLite is a good fit for CLIs, desktop applications, persistent tests, single-node services, and low-to-moderate volume queues. It is **not** a multi-host broker and is not recommended for high writer contention or network filesystems/NFS. SQLite allows concurrent readers but has one writer; this adapter deliberately uses short `BEGIN IMMEDIATE` write transactions and never holds a transaction while a worker handler executes.

## Setup

The generic entrypoint does not import a SQLite driver. Supply a structural database from a supported host binding or your own adapter:

```ts
import { Database } from 'bun:sqlite'
import { SqliteJobScheduleStore, SqliteJobStore, SqliteOutboxStore } from 'better-effect-mq-sqlite'

const database = new Database('./jobs.sqlite')
SqliteJobStore.migrate({ database }) // explicit; never run automatically

const StoreLive = SqliteJobStore.layer({
  database,
  namespace: 'desktop-app',
  configurePragmas: true
})

const ScheduleLive = SqliteJobScheduleStore.layer({
  database,
  namespace: 'desktop-app',
  configurePragmas: true
})

const OutboxLive = SqliteOutboxStore.layer({
  database,
  namespace: 'desktop-app',
  configurePragmas: true
})
```

`SqliteJobScheduleStore.layer` provides the canonical default `JobScheduleStore` token and shares
the same SQLite tables and namespace as `SqliteJobStore`. For a named store, use the associated
token and layer:

```ts
import { JobScheduleStore, JobStore } from 'better-effect-mq'
import { SqliteJobScheduleStore, SqliteJobStore } from 'better-effect-mq-sqlite'

const Durable = JobStore.named('durable')
const DurableSchedules = JobScheduleStore.for(Durable)

const DurableLive = SqliteJobStore.layerFor(Durable, { database })
const DurableSchedulesLive = SqliteJobScheduleStore.layerFor(DurableSchedules, { database })
```

`better-effect-mq-sqlite/bun` exports `openSqlite` for Bun and `better-effect-mq-sqlite/node` exports it for the current Node.js LTS's built-in `node:sqlite`. These are isolated subpaths: importing the generic package never loads Node- or Bun-specific modules.

The host-specific subpaths also expose `layerFromFile` and `outboxLayerFromFile`. They open and
close the database as part of the Layer scope. Run the matching explicit migration before opening
the layer:

```ts
import { SqliteMigrator } from 'better-effect-mq-sqlite'
import { openSqlite, outboxLayerFromFile } from 'better-effect-mq-sqlite/node'

const database = openSqlite('./jobs.sqlite')
SqliteMigrator.migrate({ database })
database.close?.()
const OutboxLive = outboxLayerFromFile({ path: './jobs.sqlite' })
```

The caller owns a supplied database and must close it. `:memory:` databases are per connection, are not persistent, and are generally not shared between connections.

## Operations

Run migrations deliberately, preferably after a backup for file databases. Migration 2 adds the
durable schedules table and due/group/key indexes; migration 3 adds the durable outbox table and
claim, lease, target/state, and recent indexes. Startup only validates the schema by default.
For caller-owned connections, PRAGMAs are changed only with `configurePragmas: true`; enable
`foreign_keys`, use a finite `busyTimeoutMs`, and use WAL for file databases where appropriate:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
```

Wake notifications are local to one store instance. Separate processes rely on SQLite file locking for correctness and polling for discovery. File permissions and local-disk backups remain application operational responsibilities.

`tickSchedule` uses a short `BEGIN IMMEDIATE` transaction. The compare-and-set revision check,
deterministic occurrence inserts (`sched/<encoded-key>/<slot>`), schedule advancement, and queue
wake version update commit together. Retrying a committed tick therefore returns `stale` without
creating a duplicate occurrence.

## Durable outbox

`SqliteOutboxStore.layer` provides the canonical `OutboxStore` token. Named outboxes use a stable
tag and an explicit layer:

```ts
import { OutboxStore } from 'better-effect-mq-outbox'
import { SqliteOutboxStore } from 'better-effect-mq-sqlite'

const BillingOutbox = OutboxStore.named('billing')
const BillingOutboxLive = SqliteOutboxStore.layerFor(BillingOutbox, {
  database,
  namespace: 'desktop-app'
})
```

`append` runs in a short `BEGIN IMMEDIATE` transaction and is idempotent for the same
`namespace`/`id` and request digest. A conflicting digest returns an error. `claim` leases rows
in FIFO order for the target namespace, increments the persisted attempt count, and recovers
expired leases before claiming. `heartbeat`, `markPublished`, `markRetry`, `markFailed`, and
`release` require the current lease token; `recoverStalled`, `list`, and `counts` support recovery
and administration. This is at-least-once storage: publishing and marking a row published are
separate operations, so consumers must be idempotent.

For an atomic application transaction, `SqliteOutboxTransactions.appendIn` accepts the real
adapter transaction type (`SqliteTransaction`, which is the caller's SQLite database connection)
and performs only the insert. The caller owns `BEGIN`/`COMMIT`/`ROLLBACK`:

```ts
import { Result } from 'better-result'
import { OutboxId } from 'better-effect-mq-outbox'
import { SqliteOutboxTransactions } from 'better-effect-mq-sqlite'

database.exec('BEGIN IMMEDIATE')
const appended = SqliteOutboxTransactions.appendIn(database, {
  id: OutboxId.make('invoice-created:123').unwrap(),
  target: 'jobs-postgres',
  request: preparedEnqueue
})
if (Result.isError(appended)) database.exec('ROLLBACK')
else database.exec('COMMIT')
```

Use `makePreparedEnqueue` from `better-effect-mq` (or the outbox normalization helpers) to build
the request accepted by `appendIn`. The adapter never hides busy, lock, commit, rollback, or
cleanup failures inside a successful result.

The adapter declares no global concurrency or rate limiting. Move to the PostgreSQL or Redis adapters when multiple hosts, high write contention, or distributed broker semantics are required.
