# better-effect-mq-mongodb

MongoDB adapter for the protocol-v1 [`better-effect-mq`](../better-effect-mq) `JobStore` and its schedules extension.

`mongodb` is an optional peer: importing this package and using a caller-owned
`Db` does not load the driver. The adapter requires MongoDB transactions, so a
standalone server is rejected at layer acquisition. Use a replica set (including
a single-node replica set for local development) or a transaction-capable mongos
deployment. Sharded deployments are not claimed as officially supported until
they have dedicated integration coverage.

## Durable job events

The events extension is an explicit migration and Layer, so existing JobStore
deployments remain compatible until it is enabled:

```ts
import { Layer } from 'better-effect'
import { JobEventStore, JobStore } from 'better-effect-mq'
import { MongoJobEventStore, MongoJobStore } from 'better-effect-mq-mongodb'

await MongoJobStore.migrate({ db })
await MongoJobEventStore.migrate({ db })

const Live = Layer.merge(
  MongoJobStore.layer({ db, namespace: 'billing' }),
  MongoJobEventStore.layer({ db, namespace: 'billing', retention: { count: 100_000 } })
)
```

Enqueue, claim, settlement, release, stalled recovery, administrative
transitions, removal, and queue pause/resume append one safe event in the same
MongoDB transaction as the JobStore mutation. The cursor counter is scoped to
the namespace. `read()` is exclusive and cursor-ordered; retention is enforced
by explicit age/count sweeps, and expired cursors are reported explicitly.
Change streams only wake `awaitEvents()` waiters; polling remains authoritative
when notifications are unavailable or a notification is lost.

Named stores use the corresponding event token:

```ts
const Durable = JobStore.named('durable')
const DurableEvents = JobEventStore.for(Durable)
const Live = Layer.merge(
  MongoJobStore.layerFor(Durable, { db }),
  MongoJobEventStore.layerFor(DurableEvents, { db })
)
```

## QueueControls protocol v3

The adapter implements durable, revisioned queue controls over separate
`${collectionPrefix}_controls`, `${collectionPrefix}_controlled_permits`,
`${collectionPrefix}_controlled_rate_windows`, and
`${collectionPrefix}_controlled_cursors` collections. Enqueue persists the
producer's `dispatchKey`; workers never derive it again. Controlled claims are
atomic MongoDB transactions that lock the control revision, fixed rate window,
bounded fairness cursor, candidate jobs, and owner-fenced permits. A legacy
`claim` is rejected while a queue has enabled controls, and a stale
`controlsRevision` fails closed.

Global concurrency, per-key concurrency, and fixed-window rate limits are
enforced together. The window is anchored at its first accepted claim and does
not refund capacity on settlement, release, cancellation, or recovery. Permits
are removed only for the matching `jobId` and `leaseToken`; stale settlement,
release, and recovery requests cannot release a newer owner. Reconciliation is
idempotent and monotonic, and `removal: 'disable'` is explicit.

```ts
import { JobScheduleStore, JobStore } from 'better-effect-mq'
import { MongoJobScheduleStore, MongoJobStore } from 'better-effect-mq-mongodb'

const StoreLive = MongoJobStore.layer({
  db,
  namespace: 'notifications',
  collectionPrefix: 'better_effect_mq'
})
```

Schedules use the associated `JobStore` token and are provided as a separate
Layer. Named stores therefore remain isolated in MongoDB namespaces:

```ts
const Durable = JobStore.named('durable')
const DurableSchedules = JobScheduleStore.for(Durable)
const StoreLive = MongoJobStore.layerFor(Durable, { db })
const ScheduleLive = MongoJobScheduleStore.layerFor(DurableSchedules, { db })
```

`tickSchedule` performs compare-and-set, deterministic occurrence insertion,
queue wake-up, and schedule advancement in one MongoDB transaction. The adapter
requires a replica set or transaction-capable mongos; standalone MongoDB is
rejected during Layer acquisition. MongoDB's transaction retry policy is
bounded, and an unknown commit result is safe to replay because the schedule
revision and occurrence ID are both deterministic.

## FlowStore v2

MongoDB also provides the protocol-v2 `FlowStore` adapter. Flow persistence is
enabled by a separate, explicit migration so an existing JobStore v1 layout is
never silently rewritten:

```ts
import { MongoJobStore } from 'better-effect-mq-mongodb'
import { MongoFlowStore } from 'better-effect-mq-mongodb'

await MongoJobStore.migrate({ db, collectionPrefix: 'better_effect_mq' })
await MongoFlowStore.migrate({ db, collectionPrefix: 'better_effect_mq' })

const FlowLive = MongoFlowStore.layer({
  db,
  namespace: 'notifications',
  collectionPrefix: 'better_effect_mq'
})
```

The flow migration records protocol v2/layout 1 independently, extends the
jobs validator with flow fields, and creates dedicated flow-child and
flow-report outbox collections. `fanOut`, child result recording, cancellation,
reconciliation, and cascade acknowledgement run in MongoDB transactions. A
terminal child settlement appends its report in the same transaction when the
persisted child carries a valid parent envelope; reports remain durable until
the parent store confirms the exact payload through `ackOutbox`.

Named JobStores use the matching FlowStore token and namespace:

```ts
import { JobStore } from 'better-effect-mq'

const Durable = JobStore.named('durable')
const FlowLive = MongoFlowStore.layerFor(Durable, { db, namespace: 'application' })
```

Flow layers validate both layout markers during acquisition and never migrate
automatically. MongoDB transactions provide the atomicity boundary; cross-store
parent/child transactions are intentionally not claimed.

## Durable outbox

The package also provides the durable protocol-v1 `OutboxStore` adapter. It
stores outbox records in a separate `${collectionPrefix}_outbox` collection and
uses the canonical default/named tokens from `better-effect-mq-outbox`:

```ts
import { MongoOutboxStore, OutboxStore } from 'better-effect-mq-mongodb'

const OutboxLive = MongoOutboxStore.layer({ db, namespace: 'billing' })
const NamedOutboxLive = MongoOutboxStore.layerFor(OutboxStore.named('billing'), {
  db,
  namespace: 'billing'
})
```

`MongoOutbox.appendIn` is the adapter-specific append boundary for an existing
MongoDB transaction. The caller starts, commits, aborts, and ends the session;
the adapter only uses it for the upsert. Equal request digests are idempotent
duplicates, while the same outbox ID with a different digest is a conflict:

```ts
import { MongoOutbox } from 'better-effect-mq-mongodb'
import { Result } from 'better-result'

const session = client.startSession()
try {
  await session.withTransaction(async () => {
    const result = await MongoOutbox.appendIn(session, record, { db })
    if (Result.isError(result)) throw result.error
  })
} finally {
  await session.endSession()
}
```

Post-commit `OutboxStore` operations claim records with expiring leases and
fresh fencing tokens. Heartbeats and settlements reject stale workers;
expired leases are recovered and records that exhaust their attempt limit are
marked failed. Delivery remains at-least-once: publication is external to the
store and must be settled explicitly with `markPublished`.

The caller retains ownership of `db.client`. For an adapter-owned client:

```ts
const StoreLive = MongoJobStore.layerFromConfig({
  uri: 'mongodb://localhost:27017/?replicaSet=rs0',
  database: 'application',
  namespace: 'notifications'
})
```

Run migrations deliberately; layers validate an existing layout and never
migrate automatically:

```ts
await MongoJobStore.migrate({ db, collectionPrefix: 'better_effect_mq' })
```

Migration creates validated `jobs`, `attempts`, `queues`, `counters`,
`migrations`, `schedules`, `outbox`, and the four QueueControls collections,
plus claim, idempotency, lease, list, ledger, metadata, controlled-claim,
permit, rate-window, due-schedule, and outbox fencing indexes. The schedules,
outbox, and controls extensions advance the MongoDB layout marker to 4 without
deleting or rewriting existing protocol-v1 data. Validation uses `moderate`/`error` to support
expand/migrate/contract rollouts; it is additional protection, not a
replacement for document decoding at the adapter boundary.

Every mutating operation runs in a short snapshot transaction with majority
write concern. The persisted queue `wakeVersion` is authoritative. Change
streams only wake local waiters when available; polling closes reconnect/history
gaps and preserves correctness. The adapter never uses server time for protocol
transitions: callers supply every `now` value.

MongoDB is responsible for replica configuration, backups, retention, document
size limits, monitoring, and index capacity. Attempt history is stored in its
own collection to avoid unbounded Job document growth. Metadata exact matches
use canonical `{ key, value }` entries, so metadata keys containing `.` or `$`
remain ordinary data; compound multikey metadata queries should be measured with
`explain('executionStats')` for the application's real filters.

Prefer PostgreSQL when relational reporting and mature operational tooling are
the priority, or Redis/Valkey for low-latency queue-centric deployments. MongoDB
is useful when the application already operates a transaction-capable replica
set and benefits from BSON document administration.
