// oxlint-disable anti-slop/no-unknown-parameters -- pg-mem function implementations receive JSON values from its emulated engine.
// oxlint-disable anti-slop/no-runtime-typeof -- pg-mem function implementations normalize emulated JSON values.
// oxlint-disable anti-slop/no-chained-type-assertions -- pg-mem's adapter is intentionally narrowed to the public Pool contract.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- pg-mem's adapter is intentionally narrowed to the public Pool contract.

import { DataType, newDb } from 'pg-mem'
import { describe, expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import { JobStore, makeQueueName } from 'better-effect-mq'
import {
  loadPostgresMigrations,
  migrationSql,
  PostgresClient,
  PostgresJobStore,
  type Pool
} from '../../src/index'

const registerPostgresFunctions = (database: ReturnType<typeof newDb>): void => {
  database.public.registerFunction({
    name: 'jsonb_typeof',
    args: [DataType.jsonb],
    returns: DataType.text,
    implementation: (value: unknown) =>
      Array.isArray(value)
        ? 'array'
        : value === null
          ? 'null'
          : typeof value === 'object'
            ? 'object'
            : typeof value
  })
  database.public.registerFunction({
    name: 'jsonb_path_exists',
    args: [DataType.jsonb, DataType.text],
    returns: DataType.bool,
    implementation: (value: unknown) =>
      Array.isArray(value) ||
      value === null ||
      typeof value !== 'object' ||
      Object.values(value).some((item) => typeof item !== 'string')
  })
}

describe('PostgreSQL adapter through pg-mem', () => {
  test('executes the packaged migration and a Pool-backed client transaction', async () => {
    const database = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
    registerPostgresFunctions(database)
    const pg = database.adapters.createPg()
    const pool = new pg.Pool()
    const schema = 'public'
    const migration = (await loadPostgresMigrations())[0]
    if (migration === undefined) throw new Error('The packaged migration is missing')
    // SAFETY: pg-mem's node-postgres adapter exposes the connect/query/end methods required by Pool.
    const adapterPool = pool as unknown as Pool
    const client = PostgresClient.fromPool({
      pool: adapterPool,
      namespace: 'pg-mem',
      schema,
      validateSchema: false
    })
    await pool.query(migrationSql(migration, schema))

    const runtime = await Runtime.make(
      PostgresJobStore.layer({
        pool: adapterPool,
        namespace: 'pg-mem',
        schema,
        validateSchema: false
      })
    )
    try {
      const tables = (await pool.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
        [schema]
      )) as { readonly rows: readonly { readonly table_name: string }[] }
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
        'better_effect_mq_attempts',
        'better_effect_mq_jobs',
        'better_effect_mq_queues',
        'better_effect_mq_schema_versions'
      ])
      expect(client.ownsPool).toBe(false)

      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const queue = makeQueueName('default').unwrap()
        const enqueued = await store.enqueue({
          job: { queue, name: 'pg-mem-job', version: 1 },
          payload: { source: 'pg-mem' },
          metadata: { source: 'pg-mem' },
          runAt: 0,
          attemptsMax: 1,
          now: 1
        })
        if (enqueued.isErr()) throw enqueued.error
        const snapshot = await store.getJob({ jobId: enqueued.value.job.id })
        const counts = await store.counts({ queue })
        return { enqueued, snapshot, counts }
      })

      expect(result.enqueued.isOk()).toBe(true)
      expect(result.snapshot.isOk() && result.snapshot.value?.payload).toEqual({
        source: 'pg-mem'
      })
      expect(result.counts.isOk() && result.counts.value.total).toBe(1)
    } finally {
      await runtime.dispose()
      await pool.end()
    }
  })
})
