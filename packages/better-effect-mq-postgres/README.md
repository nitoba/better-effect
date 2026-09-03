# better-effect-mq-postgres

`better-effect-mq-postgres` is the PostgreSQL adapter for [`better-effect-mq`](../better-effect-mq). It provides the durable `JobStore` contract over the migrated relational protocol layout, including transactional enqueue, fenced leases, transitions, inspection queries, and wake/version signalling.

`pg` is an optional peer. Importing the package, loading migrations, or using a
caller-owned pool does not load `pg`; `PostgresClient.fromConfig` loads it
lazily when it creates an owned pool. The shipped migration requires PostgreSQL
12 or newer because it uses `jsonb_path_exists` for metadata constraints.

```ts
import { PostgresJobStore } from 'better-effect-mq-postgres'

const StoreLive = PostgresJobStore.layer({
  pool,
  namespace: 'billing',
  validateSchema: true
})
```

Each layer provides only the requested `JobStore` token. It validates the schema during acquisition when `validateSchema` is true, and it never closes a caller-supplied pool. The config-backed form owns and disposes its pool:

```ts
const StoreLive = PostgresJobStore.layerFromConfig({
  connectionString,
  namespace: 'billing'
})
```

For explicit migration control:

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
and schema names are validated before quoting.
