# better-effect-mq-sqlite

Optional embedded SQLite implementation of the `better-effect-mq` protocol-v1 `JobStore` and
`JobScheduleStore` contracts.

SQLite is a good fit for CLIs, desktop applications, persistent tests, single-node services, and low-to-moderate volume queues. It is **not** a multi-host broker and is not recommended for high writer contention or network filesystems/NFS. SQLite allows concurrent readers but has one writer; this adapter deliberately uses short `BEGIN IMMEDIATE` write transactions and never holds a transaction while a worker handler executes.

## Setup

The generic entrypoint does not import a SQLite driver. Supply a structural database from a supported host binding or your own adapter:

```ts
import { Database } from 'bun:sqlite'
import { SqliteJobScheduleStore, SqliteJobStore } from 'better-effect-mq-sqlite'

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

The caller owns a supplied database and must close it. `:memory:` databases are per connection, are not persistent, and are generally not shared between connections.

## Operations

Run migrations deliberately, preferably after a backup for file databases. Migration 2 adds the
durable schedules table and due/group/key indexes; startup only validates the schema by default.
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

The adapter declares no global concurrency or rate limiting. Move to the PostgreSQL or Redis adapters when multiple hosts, high write contention, or distributed broker semantics are required.
