import { createPool, type Pool as MySqlPool } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import {
  JobStore,
  Queue,
  QueueControls,
  type ControlledJobStoreContract,
  type JobStoreError,
  type JobStoreOperation,
  makeJobId,
  makeQueueName,
  makeWorkerId
} from 'better-effect-mq'
import { Result } from 'better-result'
import { MySqlClient, MySqlJobStore } from '../src'

const uri = process.env.MYSQL_URL
const namespace = `mysql_controls_${process.pid}`
let pool: MySqlPool | undefined

const resolve = async <Value>(
  operation: JobStoreOperation<Value, JobStoreError>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const identity = (queue: string) => ({ queue, name: 'work', version: 1 }) as const
const integration = uri === undefined ? test.skip : test

const asControlledStore = (
  store: Awaited<ReturnType<typeof ServiceRuntime.resolve>>
): ControlledJobStoreContract => {
  // SAFETY: The MySQL JobStore implementation includes the controlled-store contract; this test resolves it through the base token.
  return store as ControlledJobStoreContract
}

describe('MySQL QueueControls protocol v3', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    pool = createPool({ uri, connectionLimit: 8 })
    await MySqlClient.fromPool({ pool, namespace }).migrate()
  })

  afterAll(async () => {
    if (pool === undefined) return
    for (const table of [
      'better_effect_mq_attempts',
      'better_effect_mq_controlled_permits',
      'better_effect_mq_rate_windows',
      'better_effect_mq_queue_control_cursors',
      'better_effect_mq_queue_controls',
      'better_effect_mq_jobs',
      'better_effect_mq_queues'
    ])
      await pool.query(`DELETE FROM ${table} WHERE namespace = ?`, [`${namespace}%`])
    await pool.end()
  })

  integration(
    'persists dispatch keys and enforces global, per-key, and fixed-window limits',
    async () => {
      if (pool === undefined) throw new Error('MySQL pool was not initialized')
      const queue = Queue.define('mysql-controls-basic')
      const registry = QueueControls.registry({
        group: 'mysql-controls-tests',
        controls: [
          QueueControls.define(queue, {
            globalConcurrency: 2,
            concurrencyKey: { derive: (payload: { readonly key: string }) => payload.key, max: 1 },
            rateLimit: { max: 2, durationMs: 100 }
          })
        ]
      })
      const runtime = await Runtime.make(
        MySqlJobStore.layer({ pool, namespace: `${namespace}-basic`, validateSchema: false })
      )
      try {
        const result = await runtime.run(async () => {
          const store = await ServiceRuntime.resolve(JobStore)
          const controlled = asControlledStore(store)
          const report = await resolve(controlled.reconcile(registry))
          const jobs = [
            { id: 'a-1', key: 'a' },
            { id: 'a-2', key: 'a' },
            { id: 'b-1', key: 'b' },
            { id: 'c-1', key: 'c' }
          ]
          for (const job of jobs)
            await resolve(
              store.enqueue({
                id: makeJobId(job.id).unwrap(),
                job: identity(queue.queue),
                payload: { key: job.key },
                dispatchKey: job.key,
                runAt: 0,
                attemptsMax: 2,
                now: 0
              })
            )
          const claim = await resolve(
            controlled.claimControlled({
              queue: makeQueueName(queue.queue).unwrap(),
              accepted: [identity(queue.queue)],
              limit: 3,
              workerId: makeWorkerId('worker-a').unwrap(),
              leaseDurationMs: 50,
              now: 0,
              controlsRevision: report.records[0]!.revision
            })
          )
          const blocked = await resolve(
            controlled.claimControlled({
              queue: makeQueueName(queue.queue).unwrap(),
              accepted: [identity(queue.queue)],
              limit: 1,
              workerId: makeWorkerId('worker-b').unwrap(),
              leaseDurationMs: 50,
              now: 0,
              controlsRevision: 1
            })
          )
          for (const job of claim.jobs)
            await resolve(
              controlled.settleControlled({
                jobId: job.id,
                leaseToken: job.leaseToken,
                outcome: { type: 'complete' },
                now: 1,
                controlsRevision: 1
              })
            )
          const rateLimited = await resolve(
            controlled.claimControlled({
              queue: makeQueueName(queue.queue).unwrap(),
              accepted: [identity(queue.queue)],
              limit: 1,
              workerId: makeWorkerId('worker-c').unwrap(),
              leaseDurationMs: 50,
              now: 1,
              controlsRevision: 1
            })
          )
          const nextWindow = await resolve(
            controlled.claimControlled({
              queue: makeQueueName(queue.queue).unwrap(),
              accepted: [identity(queue.queue)],
              limit: 1,
              workerId: makeWorkerId('worker-d').unwrap(),
              leaseDurationMs: 50,
              now: 100,
              controlsRevision: 1
            })
          )
          return { claim, blocked, rateLimited, nextWindow }
        })
        expect(result.claim.jobs.map((job) => job.id)).toEqual([
          makeJobId('a-1').unwrap(),
          makeJobId('b-1').unwrap()
        ])
        expect(result.claim.jobs[0]?.dispatchKey).toBe('a')
        expect(result.blocked.reason).toBe('global-concurrency')
        expect(result.rateLimited.reason).toBe('rate-limited')
        expect(result.rateLimited.nextEligibleAtMs).toBe(100)
        expect(result.nextWindow.jobs).toHaveLength(1)
        expect(result.nextWindow.jobs[0]?.id).toBe(makeJobId('c-1').unwrap())
      } finally {
        await runtime.dispose()
      }
    }
  )

  integration('fails closed for stale revisions and legacy claims', async () => {
    if (pool === undefined) throw new Error('MySQL pool was not initialized')
    const queue = Queue.define('mysql-controls-revision')
    const runtime = await Runtime.make(
      MySqlJobStore.layer({ pool, namespace: `${namespace}-revision`, validateSchema: false })
    )
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const controlled = asControlledStore(store)
        const first = await resolve(
          controlled.reconcile(
            QueueControls.registry({
              group: 'mysql-controls-tests',
              controls: [QueueControls.define(queue, { globalConcurrency: 1 })]
            })
          )
        )
        const second = await resolve(
          controlled.reconcile(
            QueueControls.registry({
              group: 'mysql-controls-tests',
              controls: [QueueControls.define(queue, { globalConcurrency: 2 })]
            })
          )
        )
        const legacy = await store.claim({
          queue: makeQueueName(queue.queue).unwrap(),
          accepted: [identity(queue.queue)],
          limit: 1,
          workerId: makeWorkerId('legacy').unwrap(),
          leaseDurationMs: 10,
          now: 0
        })
        const stale = await controlled.claimControlled({
          queue: makeQueueName(queue.queue).unwrap(),
          accepted: [identity(queue.queue)],
          limit: 1,
          workerId: makeWorkerId('worker').unwrap(),
          leaseDurationMs: 10,
          now: 0,
          controlsRevision: first.records[0]!.revision
        })
        return { second, legacy, stale }
      })
      expect(result.second.updated[0]?.revision).toBe(2)
      expect(Result.isError(result.legacy)).toBe(true)
      expect(Result.isError(result.stale)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  integration('uses one bounded permit bucket for jobs without a dispatch key', async () => {
    if (pool === undefined) throw new Error('MySQL pool was not initialized')
    const queue = Queue.define('mysql-controls-no-key')
    const runtime = await Runtime.make(
      MySqlJobStore.layer({ pool, namespace: `${namespace}-no-key`, validateSchema: false })
    )
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const controlled = asControlledStore(store)
        const report = await resolve(
          controlled.reconcile(
            QueueControls.registry({
              group: 'mysql-controls-tests',
              controls: [QueueControls.define(queue, { perKeyConcurrency: 1 })]
            })
          )
        )
        for (const id of ['no-key-1', 'no-key-2'])
          await resolve(
            store.enqueue({
              id: makeJobId(id).unwrap(),
              job: identity(queue.queue),
              payload: {},
              runAt: 0,
              attemptsMax: 2,
              now: 0
            })
          )
        const first = await resolve(
          controlled.claimControlled({
            queue: makeQueueName(queue.queue).unwrap(),
            accepted: [identity(queue.queue)],
            limit: 2,
            workerId: makeWorkerId('worker-a').unwrap(),
            leaseDurationMs: 50,
            now: 0,
            controlsRevision: report.records[0]!.revision
          })
        )
        const blocked = await resolve(
          controlled.claimControlled({
            queue: makeQueueName(queue.queue).unwrap(),
            accepted: [identity(queue.queue)],
            limit: 1,
            workerId: makeWorkerId('worker-b').unwrap(),
            leaseDurationMs: 50,
            now: 0,
            controlsRevision: 1
          })
        )
        return { first, blocked }
      })
      expect(result.first.jobs).toHaveLength(1)
      expect(result.first.jobs[0]?.dispatchKey).toBeUndefined()
      expect(result.blocked.reason).toBe('per-key-concurrency')
    } finally {
      await runtime.dispose()
    }
  })

  integration('does not let stale recovery or settlement release a new owner permit', async () => {
    if (pool === undefined) throw new Error('MySQL pool was not initialized')
    const queue = Queue.define('mysql-controls-recovery')
    const runtime = await Runtime.make(
      MySqlJobStore.layer({ pool, namespace: `${namespace}-recovery`, validateSchema: false })
    )
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const controlled = asControlledStore(store)
        const report = await resolve(
          controlled.reconcile(
            QueueControls.registry({
              group: 'mysql-controls-tests',
              controls: [QueueControls.define(queue, { globalConcurrency: 1 })]
            })
          )
        )
        await resolve(
          store.enqueue({
            id: makeJobId('recovery-1').unwrap(),
            job: identity(queue.queue),
            payload: {},
            dispatchKey: 'recovery',
            runAt: 0,
            attemptsMax: 3,
            now: 0
          })
        )
        const first = await resolve(
          controlled.claimControlled({
            queue: makeQueueName(queue.queue).unwrap(),
            accepted: [identity(queue.queue)],
            limit: 1,
            workerId: makeWorkerId('worker-a').unwrap(),
            leaseDurationMs: 10,
            now: 0,
            controlsRevision: report.records[0]!.revision
          })
        )
        await resolve(
          controlled.recoverStalledControlled({
            queue: makeQueueName(queue.queue).unwrap(),
            maxStalledCount: 5,
            limit: 1,
            now: 10,
            controlsRevision: 1
          })
        )
        const second = await resolve(
          controlled.claimControlled({
            queue: makeQueueName(queue.queue).unwrap(),
            accepted: [identity(queue.queue)],
            limit: 1,
            workerId: makeWorkerId('worker-b').unwrap(),
            leaseDurationMs: 10,
            now: 10,
            controlsRevision: 1
          })
        )
        const stale = await controlled.settleControlled({
          jobId: first.jobs[0]!.id,
          leaseToken: first.jobs[0]!.leaseToken,
          outcome: { type: 'complete' },
          now: 11,
          controlsRevision: 1
        })
        return { second, stale }
      })
      expect(result.second.jobs[0]?.leaseToken).not.toBeUndefined()
      expect(Result.isError(result.stale)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
