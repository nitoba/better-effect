# better-effect-mq-mongodb

MongoDB adapter for the protocol-v1 [`better-effect-mq`](../better-effect-mq) `JobStore` and its schedules extension.

`mongodb` is an optional peer: importing this package and using a caller-owned
`Db` does not load the driver. The adapter requires MongoDB transactions, so a
standalone server is rejected at layer acquisition. Use a replica set (including
a single-node replica set for local development) or a transaction-capable mongos
deployment. Sharded deployments are not claimed as officially supported until
they have dedicated integration coverage.

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
`migrations`, and `schedules` collections plus claim, idempotency, lease, list,
ledger, metadata, and due-schedule indexes. The schedules extension advances
the MongoDB layout marker from 1 to 2 without deleting or rewriting existing
protocol-v1 data. Validation uses `moderate`/`error` to support
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
