# better-effect-mq-mysql

`better-effect-mq-mysql` provides the optional MySQL/InnoDB `JobStore` and
`JobScheduleStore` adapters for [`better-effect-mq`](../better-effect-mq). It
implements protocol v1 and schedules v1 with short transactions, fenced leases,
durable attempt records, deterministic occurrence IDs, keyset inspection queries,
and a per-process wake notifier backed by durable queue wake versions.

```ts
import { Layer } from 'better-effect'
import { JobScheduleStore, JobStore } from 'better-effect-mq'
import { MySqlJobScheduleStore, MySqlJobStore } from 'better-effect-mq-mysql'

const StoreLive = Layer.merge(
  MySqlJobStore.layer({ pool, namespace: 'billing', validateSchema: true }),
  MySqlJobScheduleStore.layer({ pool, namespace: 'billing', validateSchema: true })
)
```

Named stores retain their association explicitly:

```ts
const Durable = JobStore.named('durable')
const DurableSchedules = JobScheduleStore.for(Durable)
const StoreLive = Layer.merge(
  MySqlJobStore.layerFor(Durable, { pool, namespace: 'billing' }),
  MySqlJobScheduleStore.layerFor(DurableSchedules, { pool, namespace: 'billing' })
)
```

The caller-owned `mysql2/promise` pool is never closed. To let the layer own its
pool, use `MySqlJobStore.layerFromConfig({ uri, namespace })`; `mysql2` is loaded
lazily only for this form.

## Requirements and migrations

MySQL **8.0.16+** with InnoDB and `STRICT_TRANS_TABLES` is required. The startup
handshake rejects MariaDB, unsupported server versions, non-InnoDB tables, and
an incompatible or incomplete protocol layout. `validateSchema: false` skips the
full catalog check but never skips the MySQL-version/SQL-mode handshake.

Migrations are explicit and are never run while acquiring a layer. Migration 3
adds the schedules table and due/group/key indexes:

```ts
import { MySqlMigrator } from 'better-effect-mq-mysql'

await MySqlMigrator.run(pool)
await MySqlMigrator.validate(pool)
```

The migrator holds a MySQL `GET_LOCK`, applies idempotent statements in order,
and records a migration only after all of its DDL succeeds. Since MySQL DDL can
commit implicitly, an interrupted migration remains detectable and safe to rerun.

Schedule ticks lock the schedule row, compare revision/`next_run_at_ms`, enqueue
deterministic `sched/<encoded-key>/<slot-ms>` jobs, update the schedule, and
advance the durable queue wake version in the same transaction. Duplicate
occurrence IDs are safe to retry, including after a lost response.

Claims use `SELECT … FOR UPDATE SKIP LOCKED` under short transactions. No
connection or transaction is held while a worker handler executes. MySQL has no
required cross-process push channel here: mutations wake local waiters after
commit, while other processes discover changes through the worker poll interval.
Correctness does not depend on that optimization.

Protocol timestamps are caller/Clock supplied epoch milliseconds; this adapter
does not use `NOW()` or `CURRENT_TIMESTAMP` for protocol decisions. Size the
pool for concurrent workers plus short administrative transactions. Deadlocks and
lock-wait timeouts are retried only at the complete transaction boundary.

Metadata filtering uses `JSON_CONTAINS` and is residual (arbitrary metadata is
not generically indexed). Operators own backups, replication, failover, and
query-plan monitoring. MariaDB is intentionally not advertised as supported.

## Integration verification

The repository runs the MySQL conformance suite when `MYSQL_URL` is set to a
dedicated MySQL 8.0.16+ test database. It covers protocol transitions, queue
pause/wake behavior, lease fencing, settlement replay, and isolated named
stores. Without that variable the real-engine suite is skipped; unit, package,
and tarball checks still run.
