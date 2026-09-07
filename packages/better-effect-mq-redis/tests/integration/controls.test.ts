// Redis integration tests are intentionally safe to run without a local server.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the runtime object is the Redis implementation behind the public JobStore contract.

import { describe, expect, test } from 'bun:test'
import {
  JobStore,
  Queue,
  QueueControls,
  makeJobId,
  makeQueueName,
  makeWorkerId
} from 'better-effect-mq'
import type { ControlledJobStoreContract } from 'better-effect-mq'
import { Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'

import { RedisJobStore } from '../../src/index'

const url = process.env.REDIS_URL
const integration = url === undefined ? test.skip : test
const prefix = `better-effect-mq-controls-${process.pid}`
let sequence = 0

const unwrap = <Value, Failure>(result: Result<Value, Failure>): Value => {
  if (Result.isError(result)) throw result.error
  return result.value
}

describe('Redis QueueControls protocol v3', () => {
  integration(
    'reconciles controls and atomically fences claims and lifecycle release',
    async () => {
      const namespace = `controls-${process.pid}-${sequence++}`
      const runtime = await Runtime.make(
        RedisJobStore.layerFromConfig({
          url: url!,
          namespace,
          prefix,
          validateLayout: true
        })
      )
      try {
        const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
        const controlled = store as typeof store & ControlledJobStoreContract
        const queue = Queue.define('redis-controlled')
        const identity = { queue: queue.name, name: 'work', version: 1 } as const
        const registry = QueueControls.registry({
          group: 'redis-controls',
          controls: [
            QueueControls.define(queue, {
              globalConcurrency: 1,
              perKeyConcurrency: 1,
              concurrencyKey: {
                derive: (payload: { readonly key: string }) => payload.key,
                max: 1
              },
              rateLimit: { max: 2, durationMs: 100 }
            })
          ]
        })

        const firstReport = unwrap(await controlled.reconcile(registry))
        expect(firstReport.created).toHaveLength(1)
        expect(firstReport.records[0]?.revision).toBe(1)
        const secondReport = unwrap(await controlled.reconcile(registry))
        expect(secondReport.unchanged[0]?.revision).toBe(1)

        const first = unwrap(
          await store.enqueue({
            id: makeJobId('redis-controlled-1').unwrap(),
            job: identity,
            payload: { key: 'a' },
            dispatchKey: 'a',
            runAt: 0,
            attemptsMax: 2,
            now: 0
          })
        )
        unwrap(
          await store.enqueue({
            id: makeJobId('redis-controlled-2').unwrap(),
            job: identity,
            payload: { key: 'a' },
            dispatchKey: 'a',
            runAt: 0,
            attemptsMax: 2,
            now: 0
          })
        )

        const claimed = unwrap(
          await controlled.claimControlled({
            queue: makeQueueName(queue.name).unwrap(),
            accepted: [identity],
            workerId: makeWorkerId('redis-controls-worker').unwrap(),
            limit: 1,
            leaseDurationMs: 50,
            now: 0,
            controlsRevision: 1
          })
        )
        expect(claimed.jobs.map((job) => job.id)).toEqual([first.job.id])
        expect(claimed.jobs[0]?.dispatchKey).toBe('a')

        const blocked = unwrap(
          await controlled.claimControlled({
            queue: makeQueueName(queue.name).unwrap(),
            accepted: [identity],
            workerId: makeWorkerId('redis-controls-worker-2').unwrap(),
            limit: 1,
            leaseDurationMs: 50,
            now: 1,
            controlsRevision: 1
          })
        )
        expect(blocked.reason).toBe('global-concurrency')

        const legacy = await store.claim({
          queue: makeQueueName(queue.name).unwrap(),
          accepted: [identity],
          workerId: makeWorkerId('redis-legacy-worker').unwrap(),
          limit: 1,
          leaseDurationMs: 50,
          now: 1
        })
        expect(Result.isError(legacy)).toBe(true)

        const released = unwrap(
          await controlled.releaseControlled({
            jobId: first.job.id,
            leaseToken: claimed.jobs[0]!.leaseToken,
            now: 2,
            controlsRevision: 1
          })
        )
        expect(released.record.state).toBe('waiting')

        const redelivered = unwrap(
          await controlled.claimControlled({
            queue: makeQueueName(queue.name).unwrap(),
            accepted: [identity],
            workerId: makeWorkerId('redis-controls-worker-3').unwrap(),
            limit: 1,
            leaseDurationMs: 50,
            now: 3,
            controlsRevision: 1
          })
        )
        expect(redelivered.jobs[0]?.id).toBe(first.job.id)

        const mismatch = await controlled.releaseControlled({
          jobId: first.job.id,
          leaseToken: redelivered.jobs[0]!.leaseToken,
          now: 4,
          controlsRevision: 2
        })
        expect(Result.isError(mismatch)).toBe(true)
      } finally {
        await runtime.dispose()
      }
    }
  )
})
