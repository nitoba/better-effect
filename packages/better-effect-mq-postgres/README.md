# better-effect-mq-postgres

`better-effect-mq-postgres` is the PostgreSQL adapter for [`better-effect-mq`](../better-effect-mq). It provides the durable `JobStore` contract over the migrated relational protocol layout, including transactional enqueue, fenced leases, transitions, inspection queries, and wake/version signalling. It also provides the PostgreSQL `JobScheduleStore` extension, with durable schedule state and atomic schedule ticks, plus the v1 `OutboxStore` persistence adapter from [`better-effect-mq-outbox`](../better-effect-mq-outbox).

`pg` is an optional peer. Importing the package, loading migrations, or using a
caller-owned pool does not load `pg`; `PostgresClient.fromConfig` loads it
lazily when it creates an owned pool. The shipped migration requires PostgreSQL
12 or newer because it uses `jsonb_path_exists` for metadata constraints. The
JobStore preserves protocol v1 for the base contract and adds controlled claim
protocol v3 in migration `005_controls_v3.sql`. Controlled queues persist the
producer's `dispatchKey`, revisioned limits, fixed windows, fairness cursors,
and fenced permits. Claims lock controls, rate windows, permits, and jobs in
that order and fail closed when a legacy claim or stale revision is presented.
See the core [compatibility policy](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq/docs/protocol/compatibility-v1.md).

## Flow protocol v2

Migration `004_flows_v2.sql` is an additive, forward-only extension. It leaves
migrations 001–003 and the v1 `OutboxStore` layout unchanged, adds the v2 flow
columns to `better_effect_mq_jobs`, and creates the dedicated
`better_effect_mq_flow_children` and `better_effect_mq_flow_outbox` tables.
Flow reports never share the generic outbox table.

`PostgresFlowStore.make()` performs a v2 handshake before returning the store:
it requires the current migration manifest and both flow tables. A v1-only
schema is rejected with `PostgresFlowProtocolMismatchError`; the flow store
does not silently reinterpret a v1 record as `waiting-children` or flow data.

The store implements the core `FlowStoreV2` operations with one PostgreSQL
transaction per atomic mutation. FanOut writes the complete parent-owned
manifest and dependency rows before moving the parent to `waiting-children`;
replaying the same manifest is acknowledged and a conflicting replay fails.
Child reports are pending-only and idempotent. Continue mode returns the parent
to `waiting` after all reports; fail-fast settles the parent first and marks
remaining dependencies for external cancellation. Parent cancellation and
cascade acknowledgement never call another store inside the transaction.

Dependency rows are locked before the parent row (`flow_children -> parent`).
Cross-store enqueue, relay, and cancellation remain at-least-once operations
performed by the Worker integration; this adapter never opens a transaction
across stores.

```ts
import { PostgresJobStore } from 'better-effect-mq-postgres'

const StoreLive = PostgresJobStore.layer({
  pool,
  namespace: 'billing',
  validateSchema: true
})
```

Schedules are associated with a `JobStore` token. Named stores therefore use
separate PostgreSQL namespaces while preserving the same Layer-first API:

```ts
import { JobScheduleStore, JobStore } from 'better-effect-mq'
import { PostgresJobScheduleStore, PostgresJobStore } from 'better-effect-mq-postgres'

const Durable = JobStore.named('durable')
const DurableSchedules = JobScheduleStore.for(Durable)
const StoreLive = PostgresJobStore.layerFor(Durable, { pool })
const ScheduleLive = PostgresJobScheduleStore.layerFor(DurableSchedules, { pool })
```

`tickSchedule` locks the schedule row, checks its revision and next slot, inserts
deterministic `sched/<encoded-key>/<slot>` jobs, advances the schedule, and
updates queue wake state in one PostgreSQL transaction. Replaying a tick is
therefore duplicate-safe.

Each layer provides only the requested `JobStore` token. It validates the schema during acquisition when `validateSchema` is true, and it never closes a caller-supplied pool. The config-backed form owns and disposes its pool:

```ts
const StoreLive = PostgresJobStore.layerFromConfig({
  connectionString,
  namespace: 'billing'
})
```

The outbox adapter appends a prepared record inside an existing PostgreSQL
transaction. It does not start, commit, or roll back that transaction, so the
domain write and outbox insert can commit or roll back together:

```ts
import { PostgresOutbox } from 'better-effect-mq-postgres'

await transaction.query('BEGIN')
await transaction.query('INSERT INTO orders ...')
await PostgresOutbox.appendIn(transaction, record, {
  namespace: 'billing',
  schema: 'public'
})
await transaction.query('COMMIT')
```

For post-commit publishing, provide only the outbox token requested by the
application. The store exposes claim, heartbeat, settlement, release,
stalled-lease recovery, listing, and count operations:

```ts
const OutboxLive = PostgresOutbox.layer({ pool, namespace: 'billing' })
const NamedOutboxLive = PostgresOutbox.layerFor(PostgresOutbox.named('emails'), {
  pool,
  namespace: 'billing'
})
```

For explicit migration control (the descriptor handshake does not replace
layout validation):

```ts
import { PostgresMigrator } from 'better-effect-mq-postgres'

await PostgresMigrator.run(pool, { schema: 'public' })
await PostgresMigrator.validate(pool, { schema: 'public' })
```

Migrations are forward-only, ordered, checksummed, idempotent, and protected by
a transaction advisory lock. The shipped `migrations/001_initial.sql` creates
`better_effect_mq_jobs`, `better_effect_mq_attempts`,
`better_effect_mq_queues`, and `better_effect_mq_schema_versions`, along with
fixed claim, lease, listing, idempotency, and metadata indexes. Protocol times
are epoch milliseconds stored in `bigint`; values are always bound parameters
and schema names are validated before quoting. Migration
`migrations/002_schedules.sql` adds the schedule table and due/group/key
indexes without modifying the initial migration. `migrations/003_outbox.sql`
adds the namespaced outbox table, digest index, claim/lease indexes, and
published-record index without modifying the JobStore or schedule tables.
Migration `migrations/005_controls_v3.sql` adds the controlled-claim layout;
its fixed-window rate limiter is anchored at the first accepted claim and does
not refund capacity on settlement, release, cancellation, or recovery.

## Upgrade and downgrade policy

The migrator is forward-only: it never runs down migrations or silently
rewrites an existing layout. Before deploying a downgrade, restore a
compatible database backup or apply a separately reviewed, documented manual
migration. A database that is newer than the running adapter must fail startup
validation rather than execute against a partially compatible schema.

For rolling deploys, introduce nullable or default-compatible columns first,
then deploy code that reads and writes them, and remove obsolete columns only
in a later expand/migrate/contract step. Breaking protocol or layout changes
must follow that sequence whenever possible. Any destructive migration
requires explicit release notes and operator approval; it is never performed
implicitly by `PostgresMigrator`.

The package tests use PGlite for PostgreSQL-engine integration and include a
small `pg-mem` smoke test for the node-postgres Pool boundary and packaged DDL.
The CI workflow runs the full optional `POSTGRES_URL` conformance suite against
PostgreSQL 16 in a service container. `pg-mem` does not replace that suite's
planner, catalog, locking, or JSON-semantics coverage.
