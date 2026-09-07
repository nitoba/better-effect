# better-effect-mq-sqlite

Optional embedded SQLite implementation of the `better-effect-mq` protocol-v1 `JobStore`,
protocol-v2 `FlowStore`, `JobScheduleStore`, and `better-effect-mq-outbox` contracts.

SQLite is a good fit for CLIs, desktop applications, persistent tests, single-node services, and low-to-moderate volume queues. It is **not** a multi-host broker and is not recommended for high writer contention or network filesystems/NFS. SQLite allows concurrent readers but has one writer; this adapter deliberately uses short `BEGIN IMMEDIATE` write transactions and never holds a transaction while a worker handler executes.

## Setup

The generic entrypoint does not import a SQLite driver. Supply a structural database from a supported host binding or your own adapter:

```ts
import { Database } from 'bun:sqlite'
import {
  SqliteFlowStore,
  SqliteJobScheduleStore,
  SqliteJobStore,
  SqliteOutboxStore
} from 'better-effect-mq-sqlite'

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

const FlowLive = SqliteFlowStore.layer({
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
claim, lease, target/state, and recent indexes; migration 4 adds the FlowStore v2 parent columns,
child manifest table, and durable flow-report outbox; migration 5 adds QueueControls v3 state and
the persisted dispatch-key column. Startup only validates the schema by default.
`SqliteFlowStore.make` and its layers require the explicit flow layout marker and fail with
`SqliteFlowProtocolMismatchError` on a v1-v3 schema; they never upgrade the database implicitly.
For caller-owned connections, PRAGMAs are changed only with `configurePragmas: true`; enable
`foreign_keys`, use a finite `busyTimeoutMs`, and use WAL for file databases where appropriate:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
```

## QueueControls protocol v3

`SqliteJobStore` implements the durable `QueueControls` extension. Migration 5 adds the persisted
`dispatch_key` column plus queue controls, rotation cursors, controlled permits, and fixed-window
rate-limit tables. `QueueControls.reconcile` is idempotent and revisioned; changing a record
increments its revision, and controlled claims fail closed when the caller presents a stale
revision. Legacy `claim` calls are rejected while controls are enabled.

Controlled claims acquire global and per-key permits, skip candidates whose dispatch key is full,
and use a bounded rotating scan so one blocked key does not hold the queue head. Rate limits use
fixed windows anchored at the first accepted claim; settlement, release, and recovery release only
the permit owned by the matching job/lease token, while rate-window capacity is never refunded.
All mutations use the adapter's serialized `BEGIN IMMEDIATE` write path, so the job transition,
permit, cursor, and rate-window updates commit as one SQLite transaction. The adapter advertises
`globalConcurrency` and `rateLimiting` after migration 5.

## FlowStore v2

`SqliteFlowStore` stores a parent flow marker and deterministic child manifest in SQLite. `fanOut`
is idempotent for the same manifest and lease, child settlement reports are appended to the flow
outbox atomically with terminal `JobStore` transitions, and `recordChildResults`, `cancel`,
`reconcile`, and `markCascaded` are bounded and retry-safe. Flow transitions use short
`BEGIN IMMEDIATE` transactions; they do not claim to make a job store and a different store key
transactional.

The generic entrypoint accepts a caller-owned `database`:

```ts
import { SqliteFlowStore } from 'better-effect-mq-sqlite'

const FlowLive = SqliteFlowStore.layer({ database, namespace: 'desktop-app' })
```

For a file-backed database, `better-effect-mq-sqlite/bun` and
`better-effect-mq-sqlite/node` additionally export `flowLayerFromFile`, which opens and closes the
host database as part of the Layer scope. Run `SqliteMigrator.migrate` first, then construct the
file layer just like the existing JobStore layer.

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
