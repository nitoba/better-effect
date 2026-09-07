import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import {
  JobStore,
  Queue,
  QueueControls,
  type ControlledJobStoreContract,
  type JobStoreOperation,
  type JobStoreError,
  makeJobId,
  makeQueueName,
  makeWorkerId
} from 'better-effect-mq'
import { Result } from 'better-result'
import {
  PostgresJobStore,
  PostgresClient,
  type Pool,
  type PoolClient,
  type QueryResult
} from '../src/index'

type Database = Awaited<ReturnType<typeof PGlite.create>>

const resolve = async <Value>(
  operation: JobStoreOperation<Value, JobStoreError>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const makePool = async (): Promise<{ readonly database: Database; readonly pool: Pool }> => {
  const database = await PGlite.create('memory://')
  const pool: Pool = {
    connect: async (): Promise<PoolClient> => ({
      query: async <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
        if (values === undefined && !/^\s*(SELECT|WITH)/iu.test(text)) {
          await database.exec(text)
          return { rows: [], rowCount: 0 }
        }
        // SAFETY: PGlite returns rows and affectedRows with the structural shape required by Pool.
        const result = (
          values === undefined ? database.query(text) : database.query(text, [...values])
        ) as Promise<{
          readonly rows: readonly Row[]
          readonly affectedRows?: number
        }>
        const resolved = await result
        return { rows: resolved.rows, rowCount: resolved.affectedRows ?? resolved.rows.length }
      },
      release: () => undefined
    })
  }
  await PostgresClient.fromPool({ pool, schema: 'mq_controls_test' }).migrate({ appliedAtMs: 1 })
  return { database, pool }
}

const identity = (queue: string) => ({ queue, name: 'work', version: 1 }) as const

describe('PostgreSQL controlled claim protocol v3', () => {
  let database: Database
  let pool: Pool

  beforeAll(async () => {
    const resources = await makePool()
    database = resources.database
    pool = resources.pool
  })

  afterAll(async () => {
    await database.close()
  })

  test('enforces global/per-key permits, skips blocked keys, and does not refund rate windows', async () => {
    const queue = Queue.define('controls-basic')
    const registry = QueueControls.registry({
      group: 'controls-tests',
      controls: [
        QueueControls.define(queue, {
          globalConcurrency: 2,
          concurrencyKey: { derive: (payload: { readonly key: string }) => payload.key, max: 1 },
          rateLimit: { max: 2, durationMs: 100 }
        })
      ]
    })
    const runtime = await Runtime.make(
      PostgresJobStore.layer({
        pool,
        schema: 'mq_controls_test',
        namespace: 'basic',
        validateSchema: false
      })
    )
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const unknownStore: unknown = store
        // SAFETY: this test exercises the adapter's documented controlled-store extension.
        const controlled = unknownStore as ControlledJobStoreContract
        const report = await resolve(controlled.reconcile(registry))
        const enqueued = await Promise.all(
          [
            { id: 'a-1', key: 'a' },
            { id: 'a-2', key: 'a' },
            { id: 'b-1', key: 'b' },
            { id: 'c-1', key: 'c' }
          ].map(({ id, key }) =>
            resolve(
              store.enqueue({
                id: makeJobId(id).unwrap(),
                job: identity('controls-basic'),
                payload: { key },
                dispatchKey: key,
                runAt: 0,
                attemptsMax: 2,
                now: 0
              })
            )
          )
        )
        const claim = await resolve(
          controlled.claimControlled({
            queue: makeQueueName('controls-basic').unwrap(),
            accepted: [identity('controls-basic')],
            limit: 3,
            workerId: makeWorkerId('worker-a').unwrap(),
            leaseDurationMs: 50,
            now: 0,
            controlsRevision: report.records[0]!.revision
          })
        )
        const blocked = await resolve(
          controlled.claimControlled({
            queue: makeQueueName('controls-basic').unwrap(),
            accepted: [identity('controls-basic')],
            limit: 1,
            workerId: makeWorkerId('worker-b').unwrap(),
            leaseDurationMs: 50,
            now: 0,
            controlsRevision: 1
          })
        )
        await Promise.all(
          claim.jobs.map((job) =>
            resolve(
              controlled.settleControlled({
                jobId: job.id,
                leaseToken: job.leaseToken,
                outcome: { type: 'complete' },
                now: 1,
                controlsRevision: 1
              })
            )
          )
        )
        const rateLimited = await resolve(
          controlled.claimControlled({
            queue: makeQueueName('controls-basic').unwrap(),
            accepted: [identity('controls-basic')],
            limit: 1,
            workerId: makeWorkerId('worker-c').unwrap(),
            leaseDurationMs: 50,
            now: 1,
            controlsRevision: 1
          })
        )
        const nextWindow = await resolve(
          controlled.claimControlled({
            queue: makeQueueName('controls-basic').unwrap(),
            accepted: [identity('controls-basic')],
            limit: 1,
            workerId: makeWorkerId('worker-d').unwrap(),
            leaseDurationMs: 50,
            now: 100,
            controlsRevision: 1
          })
        )
        return { enqueued, claim, blocked, rateLimited, nextWindow }
      })
      expect(result.enqueued).toHaveLength(4)
      expect(result.claim.jobs.map((job) => job.id)).toEqual([
        makeJobId('a-1').unwrap(),
        makeJobId('b-1').unwrap()
      ])
      expect(result.blocked.reason).toBe('global-concurrency')
      expect(result.rateLimited.reason).toBe('rate-limited')
      expect(result.rateLimited.nextEligibleAtMs).toBe(100)
      expect(result.nextWindow.jobs).toHaveLength(1)
      expect(result.nextWindow.jobs[0]?.id).toBe(makeJobId('c-1').unwrap())
    } finally {
      await runtime.dispose()
    }
  })

  test('fails closed on revision mismatch and rejects legacy claims on controlled queues', async () => {
    const queue = Queue.define('controls-revision')
    const runtime = await Runtime.make(
      PostgresJobStore.layer({
        pool,
        schema: 'mq_controls_test',
        namespace: 'revision',
        validateSchema: false
      })
    )
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const unknownStore: unknown = store
        // SAFETY: this test exercises the adapter's documented controlled-store extension.
        const controlled = unknownStore as ControlledJobStoreContract
        const initial = await resolve(
          controlled.reconcile(
            QueueControls.registry({
              group: 'controls-tests',
              controls: [QueueControls.define(queue, { globalConcurrency: 1 })]
            })
          )
        )
        const changed = await resolve(
          controlled.reconcile(
            QueueControls.registry({
              group: 'controls-tests',
              controls: [QueueControls.define(queue, { globalConcurrency: 2 })]
            })
          )
        )
        const legacy = await store.claim({
          queue: makeQueueName('controls-revision').unwrap(),
          accepted: [identity('controls-revision')],
          limit: 1,
          workerId: makeWorkerId('legacy').unwrap(),
          leaseDurationMs: 10,
          now: 0
        })
        const stale = await controlled.claimControlled({
          queue: makeQueueName('controls-revision').unwrap(),
          accepted: [identity('controls-revision')],
          limit: 1,
          workerId: makeWorkerId('worker').unwrap(),
          leaseDurationMs: 10,
          now: 0,
          controlsRevision: initial.records[0]!.revision
        })
        return { changed, legacy, stale }
      })
      expect(result.changed.updated[0]?.revision).toBe(2)
      expect(Result.isError(result.legacy)).toBe(true)
      expect(Result.isError(result.stale)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('fences release and stalled recovery while retaining permits through cancellation', async () => {
    const queue = Queue.define('controls-recovery')
    const registry = QueueControls.registry({
      group: 'controls-tests',
      controls: [QueueControls.define(queue, { globalConcurrency: 1 })]
    })
    const runtime = await Runtime.make(
      PostgresJobStore.layer({
        pool,
        schema: 'mq_controls_test',
        namespace: 'recovery',
        validateSchema: false
      })
    )
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const unknownStore: unknown = store
        // SAFETY: this test exercises the adapter's documented controlled-store extension.
        const controlled = unknownStore as ControlledJobStoreContract
        await resolve(controlled.reconcile(registry))
        const first = await resolve(
          store.enqueue({
            job: identity('controls-recovery'),
            payload: {},
            runAt: 0,
            attemptsMax: 2,
            now: 0
          })
        )
        const firstClaim = await resolve(
          controlled.claimControlled({
            queue: makeQueueName('controls-recovery').unwrap(),
            accepted: [identity('controls-recovery')],
            limit: 1,
            workerId: makeWorkerId('recovery-worker').unwrap(),
            leaseDurationMs: 5,
            now: 0,
            controlsRevision: 1
          })
        )
        const token = firstClaim.jobs[0]!.leaseToken
        const recovery = await resolve(
          controlled.recoverStalledControlled({
            queue: makeQueueName('controls-recovery').unwrap(),
            maxStalledCount: 1,
            now: 5,
            controlsRevision: 1
          })
        )
        const staleRelease = await controlled.releaseControlled({
          jobId: first.job.id,
          leaseToken: token,
          now: 5,
          controlsRevision: 1
        })
        const redelivery = await resolve(
          controlled.claimControlled({
            queue: makeQueueName('controls-recovery').unwrap(),
            accepted: [identity('controls-recovery')],
            limit: 1,
            workerId: makeWorkerId('recovery-worker-2').unwrap(),
            leaseDurationMs: 5,
            now: 5,
            controlsRevision: 1
          })
        )
        await resolve(
          controlled.cancelControlled({
            jobId: first.job.id,
            now: 6,
            controlsRevision: 1
          })
        )
        const retained = await resolve(
          controlled.claimControlled({
            queue: makeQueueName('controls-recovery').unwrap(),
            accepted: [identity('controls-recovery')],
            limit: 1,
            workerId: makeWorkerId('recovery-worker-3').unwrap(),
            leaseDurationMs: 5,
            now: 6,
            controlsRevision: 1
          })
        )
        return { recovery, staleRelease, redelivery, retained }
      })
      expect(result.recovery.recovered).toBe(1)
      expect(Result.isError(result.staleRelease)).toBe(true)
      expect(result.redelivery.jobs).toHaveLength(1)
      expect(result.retained.reason).toBe('global-concurrency')
    } finally {
      await runtime.dispose()
    }
  })
})
