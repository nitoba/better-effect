// oxlint-disable typescript/await-thenable -- Bun matchers and PGlite declarations expose synchronous-looking APIs at type level.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- malformed payloads are deliberately constructed for boundary tests.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- malformed runtime values are deliberately passed to public validation boundaries.

import { PGlite } from '@electric-sql/pglite'
import { describe, expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import { JobStore, makeJobId, makeQueueName, makeWorkerId } from 'better-effect-mq'
import {
  MIGRATION_COMPONENT,
  PostgresClient,
  PostgresJobStore,
  PostgresMigrationError,
  type Pool,
  type PoolClient,
  type QueryResult
} from '../../src/index'

type PGliteDatabase = Awaited<ReturnType<typeof PGlite.create>>

type PGliteQueryResult<Row> = {
  readonly rows: readonly Row[]
  readonly affectedRows?: number
}

const makePool = async (): Promise<{ readonly database: PGliteDatabase; readonly pool: Pool }> => {
  const database = await PGlite.create('memory://')
  return {
    database,
    pool: {
      connect: async (): Promise<PoolClient> => ({
        query: async <Row>(
          text: string,
          values?: readonly unknown[]
        ): Promise<QueryResult<Row>> => {
          const result = await runQuery<Row>(database, text, values)
          return {
            rows: result.rows,
            rowCount: result.affectedRows ?? result.rows.length
          }
        },
        release: () => undefined
      })
    }
  }
}

const explainPlan = async (
  database: PGliteDatabase,
  query: string,
  values: readonly unknown[]
): Promise<string> => {
  // SAFETY: PostgreSQL returns one string-valued QUERY PLAN column for EXPLAIN rows.
  const result = (await database.query(`EXPLAIN (COSTS OFF) ${query}`, [
    ...values
  ])) as PGliteQueryResult<{ 'QUERY PLAN': string }>
  return result.rows.map((row) => row['QUERY PLAN']).join('\n')
}

const runQuery = async <Row>(
  database: PGliteDatabase,
  text: string,
  values: readonly unknown[] | undefined
): Promise<PGliteQueryResult<Row>> => {
  if (values !== undefined) {
    // SAFETY: PGlite resolves this query to the structural result consumed by the Pool bridge.
    return database.query(text, [...values]) as Promise<PGliteQueryResult<Row>>
  }
  if (/^\s*(SELECT|WITH)/iu.test(text)) {
    // SAFETY: PGlite resolves this query to the structural result consumed by the Pool bridge.
    return database.query(text) as Promise<PGliteQueryResult<Row>>
  }
  await database.exec(text)
  return { rows: [] }
}

describe('PostgreSQL foundation via PGlite', () => {
  test('runs enqueue, claim, settle, list, and wake-version paths', async () => {
    const { database, pool } = await makePool()
    const client = PostgresClient.fromPool({ pool, schema: 'mq_store_test' })
    await client.migrate({ appliedAtMs: 1 })
    const runtime = await Runtime.make(
      PostgresJobStore.layer({ pool, schema: 'mq_store_test', validateSchema: false })
    )
    const queue = makeQueueName('default').unwrap()
    const worker = makeWorkerId('worker').unwrap()
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const payload = { nested: { value: 1 } }
        const metadata = { source: 'before' }
        const enqueuePromise = store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload,
          metadata,
          runAt: 0,
          attemptsMax: 2,
          now: 0
        })
        payload.nested.value = 2
        metadata.source = 'after'
        const enqueued = await enqueuePromise
        if (enqueued.isErr()) throw enqueued.error
        const claimed = await store.claim({
          queue,
          accepted: [{ queue, name: 'job', version: 1 }],
          limit: 1,
          workerId: worker,
          leaseDurationMs: 1000,
          now: 1
        })
        if (claimed.isErr()) throw claimed.error
        const settled = await store.settle({
          jobId: claimed.value.jobs[0]!.id,
          leaseToken: claimed.value.jobs[0]!.leaseToken,
          outcome: { type: 'complete', result: { ok: true } },
          now: 2
        })
        const listed = await store.list({ state: 'completed', limit: 10 })
        const snapshot = await store.getJob({
          jobId: enqueued.isOk() ? enqueued.value.job.id : ('missing' as never)
        })
        return { enqueued, settled, listed, snapshot }
      })
      expect(result.enqueued.isOk()).toBe(true)
      expect(result.settled.isOk()).toBe(true)
      expect(result.listed.isOk() && result.listed.value.jobs).toHaveLength(1)
      expect(result.snapshot.isOk() && result.snapshot.value?.payload).toEqual({
        nested: { value: 1 }
      })
      expect(result.snapshot.isOk() && result.snapshot.value?.metadata).toEqual({
        source: 'before'
      })
    } finally {
      await runtime.dispose()
      await database.close()
    }
  })
  test('supports idempotent settlement and keyset pagination', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_store_semantics_test'
    const client = PostgresClient.fromPool({ pool, schema })
    await client.migrate({ appliedAtMs: 1 })
    const runtime = await Runtime.make(
      PostgresJobStore.layer({ pool, schema, validateSchema: false })
    )
    const queue = makeQueueName('default').unwrap()
    const worker = makeWorkerId('worker').unwrap()
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const first = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: { value: 1 },
          idempotencyKey: 'same',
          runAt: 0,
          attemptsMax: 2,
          now: 0
        })
        const duplicate = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: { value: 99 },
          idempotencyKey: 'same',
          runAt: 0,
          attemptsMax: 2,
          now: 1
        })
        const second = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: { value: 2 },
          runAt: 0,
          attemptsMax: 2,
          now: 2
        })
        const third = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: { value: 3 },
          runAt: 0,
          attemptsMax: 2,
          now: 3
        })
        if (first.isErr() || second.isErr() || third.isErr()) throw new Error('enqueue failed')
        const claimed = await store.claim({
          queue,
          accepted: [{ queue, name: 'job', version: 1 }],
          limit: 1,
          workerId: worker,
          leaseDurationMs: 1000,
          now: 4
        })
        if (claimed.isErr()) throw claimed.error
        const settled = await store.settle({
          jobId: claimed.value.jobs[0]!.id,
          leaseToken: claimed.value.jobs[0]!.leaseToken,
          outcome: { type: 'complete', result: { ok: true } },
          now: 5
        })
        const acknowledged = await store.settle({
          jobId: claimed.value.jobs[0]!.id,
          leaseToken: claimed.value.jobs[0]!.leaseToken,
          outcome: { type: 'complete', result: { ok: true } },
          now: 6
        })
        const conflicting = await store.settle({
          jobId: claimed.value.jobs[0]!.id,
          leaseToken: claimed.value.jobs[0]!.leaseToken,
          outcome: { type: 'complete', result: { ok: false } },
          now: 7
        })
        const attempts = await store.getAttempts({ jobId: claimed.value.jobs[0]!.id })
        const page = await store.list({ limit: 2 })
        const next =
          page.isOk() && page.value.nextCursor !== undefined
            ? await store.list({ limit: 2, cursor: page.value.nextCursor })
            : page
        const equivalentPage = await store.list({ state: ['waiting', 'waiting'], limit: 1 })
        const equivalentNext =
          equivalentPage.isOk() && equivalentPage.value.nextCursor !== undefined
            ? await store.list({
                state: 'waiting',
                limit: 1,
                cursor: equivalentPage.value.nextCursor
              })
            : equivalentPage
        return {
          duplicate,
          settled,
          acknowledged,
          conflicting,
          attempts,
          page,
          next,
          equivalentPage,
          equivalentNext,
          second,
          third
        }
      })
      expect(result.duplicate.isOk() && result.duplicate.value.duplicate).toBe(true)
      expect(result.settled.isOk() && result.settled.value.status).toBe('applied')
      expect(result.acknowledged.isOk() && result.acknowledged.value.status).toBe('already-applied')
      expect(result.conflicting.isErr()).toBe(true)
      expect(result.attempts.isOk() && result.attempts.value).toHaveLength(1)
      expect(result.page.isOk() && result.page.value.jobs).toHaveLength(2)
      expect(result.next.isOk() && result.next.value.jobs).toHaveLength(1)
      expect(result.equivalentPage.isOk() && result.equivalentPage.value.nextCursor).toBeDefined()
      expect(result.equivalentNext.isOk() && result.equivalentNext.value.jobs).toHaveLength(1)
    } finally {
      await runtime.dispose()
      await database.close()
    }
  })

  test('explicit IDs take precedence over idempotency keys', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_explicit_id_test'
    const client = PostgresClient.fromPool({ pool, schema })
    await client.migrate({ appliedAtMs: 1 })
    const runtime = await Runtime.make(
      PostgresJobStore.layer({ pool, schema, validateSchema: false })
    )
    const queue = makeQueueName('default').unwrap()
    const explicitA = makeJobId('explicit-a').unwrap()
    const explicitB = makeJobId('explicit-b').unwrap()
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const generated = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: { id: 'generated' },
          idempotencyKey: 'shared-key',
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        const firstExplicit = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: { id: 'explicit-a' },
          id: explicitA,
          idempotencyKey: 'shared-key',
          runAt: 0,
          attemptsMax: 1,
          now: 1
        })
        const secondExplicit = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: { id: 'explicit-b' },
          id: explicitB,
          idempotencyKey: 'shared-key',
          runAt: 0,
          attemptsMax: 1,
          now: 2
        })
        const generatedReplay = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: { id: 'changed' },
          idempotencyKey: 'shared-key',
          runAt: 0,
          attemptsMax: 1,
          now: 3
        })
        const explicitReplay = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: { id: 'changed' },
          id: explicitA,
          idempotencyKey: 'shared-key',
          runAt: 0,
          attemptsMax: 1,
          now: 4
        })
        const counts = await store.counts()
        return { generated, firstExplicit, secondExplicit, generatedReplay, explicitReplay, counts }
      })
      expect(result.generated.isOk()).toBe(true)
      expect(result.firstExplicit.isOk() && result.firstExplicit.value.duplicate).toBe(false)
      expect(result.secondExplicit.isOk() && result.secondExplicit.value.duplicate).toBe(false)
      expect(result.generatedReplay.isOk() && result.generatedReplay.value.duplicate).toBe(true)
      expect(result.explicitReplay.isOk() && result.explicitReplay.value.duplicate).toBe(true)
      expect(
        result.firstExplicit.isOk() &&
          result.generated.isOk() &&
          result.firstExplicit.value.job.id !== result.generated.value.job.id
      ).toBe(true)
      expect(result.counts.isOk() && result.counts.value.total).toBe(3)
    } finally {
      await runtime.dispose()
      await database.close()
    }
  })

  test('finishedAt null cursors paginate unfinished jobs in both directions', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_finished_cursor_test'
    const client = PostgresClient.fromPool({ pool, schema })
    await client.migrate({ appliedAtMs: 1 })
    const runtime = await Runtime.make(
      PostgresJobStore.layer({ pool, schema, validateSchema: false })
    )
    const queue = makeQueueName('default').unwrap()
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        for (let index = 0; index < 3; index += 1) {
          const enqueued = await store.enqueue({
            job: { queue, name: 'job', version: 1 },
            payload: { index },
            runAt: 0,
            attemptsMax: 1,
            now: index
          })
          if (enqueued.isErr()) throw enqueued.error
        }
        const claimed = await store.claim({
          queue,
          accepted: [{ queue, name: 'job', version: 1 }],
          limit: 1,
          workerId: makeWorkerId('cursor-worker').unwrap(),
          leaseDurationMs: 100,
          now: 3
        })
        if (claimed.isErr()) throw claimed.error
        const settled = await store.settle({
          jobId: claimed.value.jobs[0]!.id,
          leaseToken: claimed.value.jobs[0]!.leaseToken,
          outcome: { type: 'complete', result: { done: true } },
          now: 4
        })
        if (settled.isErr()) throw settled.error
        const ascFirst = await store.list({ orderBy: 'finishedAt', order: 'asc', limit: 2 })
        const ascSecond =
          ascFirst.isOk() && ascFirst.value.nextCursor !== undefined
            ? await store.list({
                orderBy: 'finishedAt',
                order: 'asc',
                limit: 2,
                cursor: ascFirst.value.nextCursor
              })
            : ascFirst
        const descFirst = await store.list({ orderBy: 'finishedAt', order: 'desc', limit: 2 })
        const descSecond =
          descFirst.isOk() && descFirst.value.nextCursor !== undefined
            ? await store.list({
                orderBy: 'finishedAt',
                order: 'desc',
                limit: 2,
                cursor: descFirst.value.nextCursor
              })
            : descFirst
        return { ascFirst, ascSecond, descFirst, descSecond }
      })
      expect(result.ascFirst.isOk() && result.ascFirst.value.nextCursor?.value).toBe(null)
      expect(result.ascSecond.isOk() && result.ascSecond.value.jobs).toHaveLength(1)
      expect(result.descFirst.isOk() && result.descFirst.value.nextCursor?.value).toBe(null)
      expect(result.descSecond.isOk() && result.descSecond.value.jobs).toHaveLength(1)
      expect(result.descSecond.isOk() && result.descSecond.value.jobs[0]?.state).toBe('completed')
    } finally {
      await runtime.dispose()
      await database.close()
    }
  })

  test('rejects circular payloads and non-string metadata before SQL', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_validation_boundary_test'
    const client = PostgresClient.fromPool({ pool, schema })
    await client.migrate({ appliedAtMs: 1 })
    const runtime = await Runtime.make(
      PostgresJobStore.layer({ pool, schema, validateSchema: false })
    )
    const queue = makeQueueName('default').unwrap()
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const circular: Record<string, unknown> = {}
        circular.self = circular
        const circularResult = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: circular as never,
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        const metadataResult = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: {},
          metadata: { count: 1 } as never,
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        const nulPayloadResult = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: { value: '\u0000' } as never,
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        const nulIdentityResult = await store.enqueue({
          job: { queue: `bad\u0000queue` as never, name: 'job', version: 1 },
          payload: {},
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        const nulIdempotencyResult = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: {},
          idempotencyKey: 'bad\u0000key' as never,
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        return {
          circularResult,
          metadataResult,
          nulPayloadResult,
          nulIdentityResult,
          nulIdempotencyResult
        }
      })
      expect(result.circularResult.isErr()).toBe(true)
      expect(result.metadataResult.isErr()).toBe(true)
      expect(result.nulPayloadResult.isErr()).toBe(true)
      expect(result.nulIdentityResult.isErr()).toBe(true)
      expect(result.nulIdempotencyResult.isErr()).toBe(true)
      const rows = await database.query(
        `SELECT count(*)::int AS count FROM "${schema}".better_effect_mq_jobs`
      )
      expect(rows.rows[0]?.count).toBe(0)
    } finally {
      await runtime.dispose()
      await database.close()
    }
  })

  test('requeues work in quoted mixed-case schemas', async () => {
    const { database, pool } = await makePool()
    const schema = 'Mq_Quoted_Test'
    const client = PostgresClient.fromPool({ pool, schema })
    await client.migrate({ appliedAtMs: 1 })
    const runtime = await Runtime.make(
      PostgresJobStore.layer({ pool, schema, validateSchema: false })
    )
    const queue = makeQueueName('default').unwrap()
    const worker = makeWorkerId('quoted-worker').unwrap()
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const enqueued = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: {},
          runAt: 0,
          attemptsMax: 2,
          now: 0
        })
        if (enqueued.isErr()) throw enqueued.error
        const claimed = await store.claim({
          queue,
          accepted: [{ queue, name: 'job', version: 1 }],
          limit: 1,
          workerId: worker,
          leaseDurationMs: 100,
          now: 1
        })
        if (claimed.isErr()) throw claimed.error
        const released = await store.release({
          jobId: claimed.value.jobs[0]!.id,
          leaseToken: claimed.value.jobs[0]!.leaseToken,
          now: 2
        })
        const current = await store.getJob({ jobId: enqueued.value.job.id })
        return { enqueued, released, current }
      })
      expect(result.released.isOk()).toBe(true)
      expect(result.current.isOk() && result.current.value?.orderingSequence).toBeGreaterThan(
        result.enqueued.isOk() ? result.enqueued.value.job.orderingSequence : 0
      )
    } finally {
      await runtime.dispose()
      await database.close()
    }
  })

  test('recovers expired leases with the stalled policy', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_store_recovery_test'
    const client = PostgresClient.fromPool({ pool, schema })
    await client.migrate({ appliedAtMs: 1 })
    const runtime = await Runtime.make(
      PostgresJobStore.layer({ pool, schema, validateSchema: false })
    )
    const queue = makeQueueName('default').unwrap()
    const worker = makeWorkerId('worker').unwrap()
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const enqueued = await store.enqueue({
          job: { queue, name: 'job', version: 1 },
          payload: {},
          runAt: 0,
          attemptsMax: 2,
          now: 0
        })
        if (enqueued.isErr()) throw enqueued.error
        const claimed = await store.claim({
          queue,
          accepted: [{ queue, name: 'job', version: 1 }],
          limit: 1,
          workerId: worker,
          leaseDurationMs: 1,
          now: 0
        })
        if (claimed.isErr()) throw claimed.error
        const heartbeat = await store.heartbeat({
          leases: [
            {
              jobId: claimed.value.jobs[0]!.id,
              leaseToken: claimed.value.jobs[0]!.leaseToken
            },
            { jobId: 'missing' as never, leaseToken: 'missing-token' as never }
          ],
          leaseDurationMs: 1,
          now: 0
        })
        const recovered = await store.recoverStalled({ maxStalledCount: 0, now: 1 })
        const attempts = await store.getAttempts({ jobId: claimed.value.jobs[0]!.id })
        return { heartbeat, recovered, attempts }
      })
      expect(result.heartbeat.isOk()).toBe(true)
      expect(result.heartbeat.isOk() && Object.isFrozen(result.heartbeat.value.renewed)).toBe(true)
      expect(result.heartbeat.isOk() && Object.isFrozen(result.heartbeat.value.lost)).toBe(true)
      expect(result.heartbeat.isOk() && Object.isFrozen(result.heartbeat.value.lost[0])).toBe(true)
      expect(result.recovered.isOk() && result.recovered.value.recovered).toBe(1)
      expect(result.recovered.isOk() && result.recovered.value.transitions[0]?.record.state).toBe(
        'failed'
      )
      expect(result.attempts.isOk() && result.attempts.value[0]?.outcome).toBe('stalled')
    } finally {
      await runtime.dispose()
      await database.close()
    }
  })

  test('migrates, validates, and remains idempotent on a fresh custom schema', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_foundation_test'
    const client = PostgresClient.fromPool({ pool, schema })
    try {
      await expect(client.migrate({ appliedAtMs: 1 })).resolves.toMatchObject({
        applied: [1],
        schema,
        version: 1
      })
      const historyBefore = await database.query(
        `SELECT applied_at_ms, checksum FROM "${schema}".better_effect_mq_schema_versions WHERE component = $1`,
        ['better-effect-mq']
      )
      await expect(client.migrate({ appliedAtMs: 2 })).resolves.toMatchObject({ applied: [] })
      const historyAfter = await database.query(
        `SELECT applied_at_ms, checksum FROM "${schema}".better_effect_mq_schema_versions WHERE component = $1`,
        ['better-effect-mq']
      )
      expect(historyAfter.rows).toEqual(historyBefore.rows)
      await expect(client.validate()).resolves.toMatchObject({ schema, version: 1 })
    } finally {
      await database.close()
    }
  })

  test('serializes concurrent migrations and applies the manifest once', async () => {
    const { database, pool } = await makePool()
    const client = PostgresClient.fromPool({ pool, schema: 'mq_concurrent_test' })
    try {
      const results = await Promise.all([
        client.migrate({ appliedAtMs: 1 }),
        client.migrate({ appliedAtMs: 2 })
      ])
      expect(
        results
          .map((result) => result.applied)
          .sort((left, right) => (left[0] ?? 0) - (right[0] ?? 0))
      ).toEqual([[], [1]])
      await expect(client.validate()).resolves.toMatchObject({ version: 1 })
    } finally {
      await database.close()
    }
  })

  test('does not record migration history over a malformed pre-existing layout', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_malformed_layout_test'
    const client = PostgresClient.fromPool({ pool, schema })
    try {
      await client.migrate({ appliedAtMs: 1 })
      await database.query(
        `DELETE FROM "${schema}".better_effect_mq_schema_versions WHERE component = $1`,
        ['better-effect-mq']
      )
      await database.exec(
        `ALTER TABLE "${schema}".better_effect_mq_jobs DROP CONSTRAINT better_effect_mq_jobs_version`
      )
      await database.exec(
        `ALTER TABLE "${schema}".better_effect_mq_jobs ADD CONSTRAINT better_effect_mq_jobs_version CHECK (true)`
      )
      // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
      await expect(client.migrate({ appliedAtMs: 2 })).rejects.toBeInstanceOf(
        PostgresMigrationError
      )
      const history = await database.query(
        `SELECT component FROM "${schema}".better_effect_mq_schema_versions WHERE component = $1`,
        ['better-effect-mq']
      )
      expect(history.rows).toHaveLength(0)
    } finally {
      await database.close()
    }
  })

  test('does not allow components to claim the same physical schema', async () => {
    const { database, pool } = await makePool()
    const client = PostgresClient.fromPool({ pool, schema: 'mq_component_test' })
    try {
      await expect(client.migrate({ component: 'alternate-component' })).resolves.toMatchObject({
        component: 'alternate-component',
        applied: [1]
      })
      // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
      await expect(client.migrate({ component: MIGRATION_COMPONENT })).rejects.toBeInstanceOf(
        PostgresMigrationError
      )
    } finally {
      await database.close()
    }
  })

  test('enforces the protocol metadata and lease constraints', async () => {
    const { database, pool } = await makePool()
    const client = PostgresClient.fromPool({ pool, schema: 'mq_constraints_test' })
    try {
      await client.migrate({ appliedAtMs: 1 })
      await expect(
        database.query(
          `INSERT INTO "mq_constraints_test".better_effect_mq_jobs
           (namespace, id, queue, name, version, state, payload, metadata, priority, run_at_ms,
            attempts_max, attempts_made, delivery_count, stalled_count, created_at_ms, updated_at_ms)
           VALUES ($1, $2, $3, $4, 1, 'waiting', '{}'::jsonb, '{"number": 1}'::jsonb, 0, 0, 1, 0, 0, 0, 0, 0)`,
          ['test', 'job-1', 'default', 'job']
        )
      ).rejects.toBeDefined()
      await expect(
        database.query(
          `INSERT INTO "mq_constraints_test".better_effect_mq_jobs
           (namespace, id, queue, name, version, state, payload, metadata, priority, run_at_ms,
            attempts_max, attempts_made, delivery_count, stalled_count, created_at_ms, updated_at_ms)
           VALUES ($1, $2, $3, $4, 1, 'active', '{}'::jsonb, '{}'::jsonb, 0, 0, 1, 0, 1, 0, 0, 0)`,
          ['test', 'job-2', 'default', 'job']
        )
      ).rejects.toBeDefined()
      await expect(
        database.query(
          `INSERT INTO "mq_constraints_test".better_effect_mq_jobs
           (namespace, id, queue, name, version, state, payload, metadata, priority, run_at_ms,
            attempts_max, attempts_made, delivery_count, stalled_count, created_at_ms, updated_at_ms)
           VALUES ($1, $2, $3, $4, 1, 'waiting', '{}'::jsonb, '{}'::jsonb, 0, 0, 1, 1, 1, 0, 0, 0)`,
          ['test', 'job-3', 'default', 'job']
        )
      ).rejects.toBeDefined()
      await expect(
        database.query(
          `INSERT INTO "mq_constraints_test".better_effect_mq_jobs
           (namespace, id, queue, name, version, state, payload, metadata, priority, run_at_ms,
            attempts_max, attempts_made, delivery_count, stalled_count, created_at_ms, updated_at_ms,
            lease_owner, lease_token, lease_expires_at_ms)
           VALUES ($1, $2, $3, $4, 1, 'active', '{}'::jsonb, '{}'::jsonb, 0, 0, 2, 1, 1, 0, 0, 0, 'worker', 'token', 1)`,
          ['test', 'job-4', 'default', 'job']
        )
      ).rejects.toBeDefined()
    } finally {
      await database.close()
    }
  })

  test('critical access paths have matching query plans', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_query_plan_test'
    const client = PostgresClient.fromPool({ pool, schema })
    try {
      await client.migrate({ appliedAtMs: 1 })
      await database.exec('SET enable_seqscan = off')
      const claimPlan = await explainPlan(
        database,
        `SELECT id FROM "${schema}".better_effect_mq_jobs
         WHERE namespace = $1 AND queue = $2 AND state = 'waiting'
           AND run_at_ms <= $3
         ORDER BY priority DESC, run_at_ms ASC, sequence ASC, id COLLATE "C" ASC
         LIMIT 1`,
        ['test', 'default', 0]
      )
      const leasePlan = await explainPlan(
        database,
        `SELECT id FROM "${schema}".better_effect_mq_jobs
         WHERE namespace = $1 AND state = 'active' AND lease_expires_at_ms <= $2
         ORDER BY lease_expires_at_ms ASC LIMIT 1`,
        ['test', 0]
      )
      const terminalPlan = await explainPlan(
        database,
        `SELECT id FROM "${schema}".better_effect_mq_jobs
         WHERE namespace = $1 AND state IN ('completed', 'failed', 'cancelled')
         ORDER BY finished_at_ms DESC, sequence DESC, id COLLATE "C" DESC LIMIT 10`,
        ['test']
      )
      const idempotencyPlan = await explainPlan(
        database,
        `SELECT id FROM "${schema}".better_effect_mq_jobs
         WHERE namespace = $1 AND queue = $2 AND name = $3 AND version = $4
           AND dedupe_key = $5`,
        ['test', 'default', 'job', 1, 'request-1']
      )
      expect(claimPlan).toContain('better_effect_mq_jobs_claim_idx')
      expect(leasePlan).toContain('better_effect_mq_jobs_active_lease_idx')
      expect(terminalPlan).toContain('better_effect_mq_jobs_terminal_idx')
      expect(idempotencyPlan).toContain('better_effect_mq_jobs_idempotency_idx')
    } finally {
      await database.close()
    }
  })

  test('validation detects incompatible nullability and missing protocol columns', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_validation_test'
    const client = PostgresClient.fromPool({ pool, schema })
    try {
      await client.migrate({ appliedAtMs: 1 })
      await database.exec(
        `ALTER TABLE "${schema}".better_effect_mq_jobs ALTER COLUMN metadata DROP NOT NULL`
      )
      await database.exec(
        `ALTER TABLE "${schema}".better_effect_mq_jobs DROP CONSTRAINT better_effect_mq_jobs_version`
      )
      await database.exec(
        `ALTER TABLE "${schema}".better_effect_mq_jobs ADD CONSTRAINT better_effect_mq_jobs_version CHECK (version > 0 OR TRUE)`
      )
      await database.exec(
        `ALTER TABLE "${schema}".better_effect_mq_jobs DROP CONSTRAINT better_effect_mq_jobs_nonempty`
      )
      await database.exec(
        `ALTER TABLE "${schema}".better_effect_mq_jobs ADD CONSTRAINT better_effect_mq_jobs_nonempty CHECK (namespace <> '' AND id <> '' AND queue <> '' AND name <> '') NOT VALID`
      )
      await database.exec(
        `CREATE TABLE "${schema}".better_effect_mq_wrong_jobs (namespace text NOT NULL, id text NOT NULL, PRIMARY KEY (namespace, id))`
      )
      await database.exec(
        `ALTER TABLE "${schema}".better_effect_mq_attempts DROP CONSTRAINT better_effect_mq_attempts_job_fk`
      )
      await database.exec(
        `ALTER TABLE "${schema}".better_effect_mq_attempts ADD CONSTRAINT better_effect_mq_attempts_job_fk FOREIGN KEY (namespace, job_id) REFERENCES "${schema}".better_effect_mq_wrong_jobs(namespace, id) ON DELETE RESTRICT`
      )
      await database.exec(`ALTER TABLE "${schema}".better_effect_mq_attempts DROP COLUMN worker_id`)
      await database.exec(`DROP INDEX "${schema}".better_effect_mq_jobs_claim_idx`)
      await database.exec(
        `CREATE INDEX better_effect_mq_jobs_claim_idx ON "${schema}".better_effect_mq_jobs (namespace)`
      )
      // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
      await expect(client.validate()).rejects.toMatchObject({
        problems: expect.arrayContaining([
          'incompatible nullability better_effect_mq_jobs.metadata',
          'incompatible constraint better_effect_mq_jobs_version',
          'incompatible constraint better_effect_mq_jobs_nonempty',
          'incompatible constraint better_effect_mq_attempts_job_fk',
          'incompatible index better_effect_mq_jobs_claim_idx',
          'missing column better_effect_mq_attempts.worker_id'
        ])
      })
    } finally {
      await database.close()
    }
  })
})
