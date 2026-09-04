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
