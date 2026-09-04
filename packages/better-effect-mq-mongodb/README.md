# better-effect-mq-mongodb

MongoDB adapter for the protocol-v1 [`better-effect-mq`](../better-effect-mq) `JobStore`.

`mongodb` is an optional peer: importing this package and using a caller-owned
`Db` does not load the driver. The adapter requires MongoDB transactions, so a
standalone server is rejected at layer acquisition. Use a replica set (including
a single-node replica set for local development) or a transaction-capable mongos
deployment. Sharded deployments are not claimed as officially supported until
they have dedicated integration coverage.

```ts
import { MongoJobStore } from 'better-effect-mq-mongodb'

const StoreLive = MongoJobStore.layer({
  db,
  namespace: 'notifications',
  collectionPrefix: 'better_effect_mq'
})
```

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

Migration creates validated `jobs`, `attempts`, `queues`, `counters`, and
`migrations` collections plus claim, idempotency, lease, list, ledger, and
metadata indexes. Validation uses `moderate`/`error` to support expand/migrate/
contract rollouts; it is additional protection, not a replacement for document
decoding at the adapter boundary.

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
