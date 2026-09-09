# MQ storage adapters and transactional outbox

Storage adapters implement the core JobStore/extension contracts. Keep
Queue/Job/Worker application code in [better-effect-mq](mq.md). Install the
chosen adapter and its optional driver only where used; inspect peer ranges
in the target lockfile instead of assuming all packages share a version.

## Adapter matrix

| Package | Caller-owned resource | Adapter-owned factory | Explicit setup |
| --- | --- | --- | --- |
| `better-effect-mq-postgres` | `PostgresJobStore.layer({ pool, namespace })` | `.layerFromConfig({ connectionString, namespace })` | `PostgresMigrator.run(pool, options)` and validate |
| `better-effect-mq-redis` | Client-based RedisJobStore factories | `.layerFromConfig({ url, namespace })` | Namespaced initialized clients; configure persistence/failover separately |
| `better-effect-mq-mysql` | `MySqlJobStore.layer({ pool, namespace })` | `.layerFromConfig({ uri, namespace, poolConfig })` | `MySqlMigrator.run(pool)` and validate |
| `better-effect-mq-mongodb` | `MongoJobStore.layer({ db, namespace })` | `.layerFromConfig({ uri, database, namespace })` | `MongoJobStore.migrate({ db })`; extra MongoFlowStore migration for Flow |
| `better-effect-mq-sqlite` | `SqliteJobStore.layer({ database, namespace })` | Host `layerFromFile({ path, namespace })` | Synchronous `SqliteMigrator.migrate({ database })` |

Borrowed resources remain caller-owned and must outlive Runtime disposal.
From-config/file factories own what they create; do not close those resources
a second time. If several adapters need one pool/client, provide one owner
rather than invoking independent owning factories for each facade.

SQL/Mongo/SQLite migration and validation are different actions. Run migration
at an explicit deploy/startup boundary **before** acquisition validates layout;
normal application Layer acquisition does not silently migrate it. Keep schema,
namespace, collectionPrefix, and related settings aligned across extensions.
Named `layerFor`/corresponding factories install the selected token, not a
second Runtime.

## Adapter-specific constraints

**PostgreSQL.** Use the package's PostgresJobStore, JobEventStore,
JobScheduleStore, Flow, and PostgresOutbox surfaces for the corresponding core
capabilities. `pg` is loaded only for factories that create a pool. The
[PostgreSQL guide](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq-postgres/README.md)
documents schema/namespace consistency, migrations, and pool interfaces.

**Redis/Valkey.** `RedisJobStore.layerWithEventsFromConfig(config, eventOptions)`
provides matching JobStore and JobEventStore. Other feature stores remain
explicit. RedisClient represents the command/subscriber pair;
RedisFlowStore.make is a lower-level surface, so do not invent uniform Layer
helpers by copying SQL adapter names. RedisOutboxStore and
RedisOutbox.transaction implement **Redis-native** outbox writes, not atomic
transactions with an unrelated SQL database. Check the exact client's cluster,
persistence, TLS, replication, and failover behavior in the
[Redis guide](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq-redis/README.md).
Bounded events are not archival storage.

**MySQL.** Export names use `MySql`, not `Mysql`. The current adapter requires
MySQL 8.0.16+, InnoDB, and STRICT_TRANS_TABLES; MariaDB is not certified/supported
by this contract. `mysql2/promise` pools are lazily created by owning factories.
Retain schema/server validation. See the
[MySQL guide](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq-mysql/README.md).

**MongoDB.** A transaction-capable replica set or mongos is required; standalone
MongoDB is rejected. A single-node replica set works for development. A borrowed
Db must retain its MongoClient for sessions. Use `validateLayout`, and apply
both job and flow migrations when Flow is enabled. Change streams are hints,
with polling fallback; notifications can explicitly use poll. See the
[MongoDB guide](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq-mongodb/README.md).

**SQLite.** Import `openSqlite`/`layerFromFile` from `/bun` or `/node`, not the
neutral root. Bun uses bun:sqlite; Node uses node:sqlite and its actual host
requirements. The root accepts a structural database without importing either
binding. Migrate using a deliberately opened connection; a new `:memory:`
connection does not share the old one's schema/state. SQLite serializes writers
and is not a multi-host broker over a network filesystem. See the
[SQLite guide](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq-sqlite/README.md).

## Outbox: prepare, commit, publish

`better-effect-mq-outbox` makes a domain write and a future job request durable
in **one native database transaction**. It does not add distributed transactions
or exactly-once effects. The application-facing sequence is:

1. Yield `Job.prepare(payload, options)` inside the existing Runtime.
2. Validate an OutboxId and call `makeOutboxRecord` with a stable target/request.
3. Call the adapter's **record-first** transaction helper. Its callback performs
   domain writes; the adapter appends the supplied record after callback success
   and owns commit, rollback, and connection/session cleanup.
4. A Layer-owned OutboxPublisher reads committed records and enqueues into the
   JobStore selected by OutboxRoutes. The normal Worker handles the Job.

For PostgreSQL, after obtaining `record` as a successful makeOutboxRecord value
and an application-owned native pool, the transaction shape is:

```ts
import { Result } from 'better-result'
import { PostgresOutbox } from 'better-effect-mq-postgres'

const persisted = await PostgresOutbox.transaction(
  pool,
  record,
  async (transaction) => {
    await transaction.query(
      'INSERT INTO orders (id, email) VALUES ($1, $2)',
      [orderId, email]
    )
    return Result.ok(undefined)
  },
  { namespace: 'orders' }
)
```

This is a transaction fragment, not an independently configured application.
The [complete outbox example](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq-outbox/README.md)
includes preparation, record validation, migrations, provider composition,
publication, and terminal observation.

The signature is `transaction(resource, preparedRecord, callback, options?)`:
not callback-first, not enqueue-then-insert, and not a second Runtime inside a
transaction. `appendIn` is an advanced escape hatch only when the caller truly
owns a supported native transaction. A Kysely transaction object is not
interchangeable with an adapter's native pool/client/session contract.

## Publisher composition and failure handling

`OutboxId.make` and `makeOutboxRecord` return Results; yield/handle them, rather
than using unchecked unwrap in request code. Prepare data only, never persist
a live codec, Service, Runtime, callback, or connection in an outbox record.
A stable ID with the same request is idempotent; reusing it for another request
is a conflict and must remain visible.

`OutboxRoutes.make({ jobs: JobStore })` maps string targets to **Service tokens**,
not instances. A record's target must exactly match a route. Named outboxes use
`OutboxStore.named`; providers and publisher configuration must use that token.

`OutboxPublisher.service(tag).layer(() => ({ outboxes, routes, concurrency,
leaseDurationMs, heartbeatIntervalMs, pollIntervalMs }))` owns the publisher.
Compose its Clock and matching stores with worker Layers; warm/resolve the
publisher before readiness. Missing routes and exhausted retries remain
observable failed records, not silently dropped messages.

Shutdown quiesces new claims, drains admitted publication/attempts, then
releases stores. Publication is at least once: a crash after enqueue but before
outbox settlement can repeat delivery. Handler-side effects still require
idempotency. MemoryOutboxStore is for process-local tests, not production
durability or a substitute for the domain transaction.
