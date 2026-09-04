# better-effect-mq-mysql

`better-effect-mq-mysql` provides the optional MySQL/InnoDB `JobStore` adapter for
[`better-effect-mq`](../better-effect-mq). It implements protocol v1 with short
transactions, fenced leases, durable attempt records, keyset inspection queries,
and a per-process wake notifier backed by durable queue wake versions.

```ts
import { MySqlJobStore } from 'better-effect-mq-mysql'

const StoreLive = MySqlJobStore.layer({
  pool,
  namespace: 'billing',
  validateSchema: true
})
```

The caller-owned `mysql2/promise` pool is never closed. To let the layer own its
pool, use `MySqlJobStore.layerFromConfig({ uri, namespace })`; `mysql2` is loaded
lazily only for this form.

## Requirements and migrations

MySQL **8.0.16+** with InnoDB and `STRICT_TRANS_TABLES` is required. The startup
handshake rejects MariaDB, unsupported server versions, non-InnoDB tables, and
an incompatible or incomplete protocol layout. `validateSchema: false` skips the
full catalog check but never skips the MySQL-version/SQL-mode handshake.

Migrations are explicit and are never run while acquiring a layer:

```ts
import { MySqlMigrator } from 'better-effect-mq-mysql'

await MySqlMigrator.run(pool)
await MySqlMigrator.validate(pool)
```

The migrator holds a MySQL `GET_LOCK`, applies idempotent statements in order,
and records a migration only after all of its DDL succeeds. Since MySQL DDL can
commit implicitly, an interrupted migration remains detectable and safe to rerun.

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
