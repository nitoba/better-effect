// Redis integration tests are intentionally safe to run without a local server.

import { describe, expect, test } from 'bun:test'
import { sendRedisCommand, type RedisCommandClient } from '../../src/config'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Codec, JobStore, Queue, makeJobId, makeQueueName, makeWorkerId } from 'better-effect-mq'
import type { Result as ResultType } from 'better-result'
import { createRedisClientFromConfig, RedisJobStore } from '../../src/index'
import { stringsReply } from '../../src/internal/replies'

const url = process.env.REDIS_URL
const integration = url === undefined ? test.skip : test
const prefix = `better-effect-mq-integration-${process.pid}`
let sequence = 0

const config = (namespace: string) => {
  const base = { namespace, prefix, validateLayout: true }
  return url === undefined ? base : { ...base, url }
}

const unwrap = <Value, Failure>(result: ResultType<Value, Failure>): Value => {
  if (result.isErr()) throw result.error
  return result.value
}

const queue = Queue.define('redis-integration')
const job = queue.job('redis-job', {
  version: 1,
  payload: Codec.json<{ readonly value: string }>()
})
const otherJob = queue.job('redis-other', {
  version: 1,
  payload: Codec.json<{ readonly value: string }>()
})
const queueName = makeQueueName(queue.name).unwrap()
const settlementWorkerId = makeWorkerId('settlement-race-worker').unwrap()

describe('RedisJobStore public integration', () => {
  integration('provides the default JobStore layer and persists a job', async () => {
    const namespace = `store-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const now = Date.now()
      const enqueued = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'public-api' },
          metadata: { test: 'redis-store' },
          runAt: now,
          attemptsMax: 3,
          now
        })
      )
      expect(enqueued.duplicate).toBe(false)

      const found = unwrap(await store.getJob({ jobId: enqueued.job.id }))
      expect(found).toMatchObject({
        id: enqueued.job.id,
        state: 'waiting',
        metadata: { test: 'redis-store' },
        payload: { value: 'public-api' }
      })
    } finally {
      await runtime.dispose()
    }
  })

  integration('accepts negative priorities through enqueue and claim', async () => {
    const namespace = `negative-priority-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const enqueued = unwrap(
        await store.enqueueMany([
          {
            job: job.identity,
            payload: { value: 'negative-priority' },
            priority: -1,
            runAt: 0,
            attemptsMax: 1,
            now: 0
          }
        ])
      )[0]!
      const claimed = unwrap(
        await store.claim({
          queue: queueName,
          accepted: [job.identity],
          workerId: makeWorkerId('negative-priority-worker').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          now: 1
        })
      ).jobs[0]
      expect(claimed?.id).toBe(enqueued.job.id)
      expect(claimed?.priority).toBe(-1)
    } finally {
      await runtime.dispose()
    }
  })

  integration('rejects malformed delayed scores before promotion', async () => {
    const namespace = `invalid-score-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    let client: Awaited<ReturnType<typeof createRedisClientFromConfig>> | undefined
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const enqueued = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'invalid-score' },
          runAt: 10,
          attemptsMax: 1,
          now: 0
        })
      )
      client = await createRedisClientFromConfig(config(namespace))
      await client.initialize()
      const delayed = client.layout.delayed(queueName, job.name, job.version)
      const members = stringsReply(
        await sendRedisCommand(client.client, ['ZRANGE', delayed, '0', '0'], client.layout.base)
      )
      expect(members).toHaveLength(1)
      await sendRedisCommand(
        client.client,
        ['ZADD', delayed, '101.5', members[0]!],
        client.layout.base
      )
      const claimed = await store.claim({
        queue: queueName,
        accepted: [job.identity],
        workerId: makeWorkerId('invalid-score-worker').unwrap(),
        limit: 1,
        leaseDurationMs: 10,
        now: 100
      })
      expect(claimed.isErr()).toBe(true)
      expect(unwrap(await store.getJob({ jobId: enqueued.job.id }))).toMatchObject({
        id: enqueued.job.id,
        state: 'delayed',
        runAt: 10
      })
    } finally {
      await client?.dispose()
      await runtime.dispose()
    }
  })

  integration('gives explicit IDs precedence over idempotency keys', async () => {
    const namespace = `precedence-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const now = Date.now()
      const first = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'mapped-first' },
          idempotencyKey: 'same-key',
          runAt: now,
          attemptsMax: 1,
          now
        })
      )
      const explicit = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'explicit-wins' },
          id: makeJobId('explicit-precedence').unwrap(),
          idempotencyKey: 'same-key',
          runAt: now,
          attemptsMax: 1,
          now
        })
      )
      expect(first.duplicate).toBe(false)
      expect(explicit).toMatchObject({ duplicate: false, job: { id: 'explicit-precedence' } })
    } finally {
      await runtime.dispose()
    }
  })

  integration('resolves legacy Unicode idempotency mappings canonically', async () => {
    const namespace = `legacy-mapping-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    let client: Awaited<ReturnType<typeof createRedisClientFromConfig>> | undefined
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const legacyId = makeJobId('legacy:é').unwrap()
      unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'legacy' },
          id: legacyId,
          idempotencyKey: 'legacy-key',
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
      )
      client = await createRedisClientFromConfig(config(namespace))
      await client.initialize()
      const idempotency = client.layout.idempotency(`${queueName}:${job.name}:${job.version}`)
      await sendRedisCommand(
        client.client,
        ['HSET', idempotency, 'legacy-key', legacyId],
        client.layout.base
      )
      const replay = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'replay' },
          idempotencyKey: 'legacy-key',
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
      )
      expect(replay).toMatchObject({ duplicate: true, job: { id: legacyId } })
      expect(unwrap(await store.counts({})).total).toBe(1)
    } finally {
      await client?.dispose()
      await runtime.dispose()
    }
  })

  integration('chunks large enqueueMany requests without losing alignment', async () => {
    const namespace = `batch-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const now = Date.now()
      const result = unwrap(
        await store.enqueueMany(
          Array.from({ length: 130 }, (_, index) => ({
            job: job.identity,
            payload: { value: `batch-${index}` },
            runAt: now,
            attemptsMax: 1,
            now
          }))
        )
      )
      expect(result).toHaveLength(130)
      expect(result.every((item) => item.duplicate === false)).toBe(true)
      expect(unwrap(await store.counts({})).total).toBe(130)
    } finally {
      await runtime.dispose()
    }
  })

  integration('scopes batch idempotency by job identity', async () => {
    const namespace = `batch-identity-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const now = Date.now()
      const result = unwrap(
        await store.enqueueMany([
          {
            job: job.identity,
            payload: { value: 'first-identity' },
            idempotencyKey: 'same-key',
            runAt: now,
            attemptsMax: 1,
            now
          },
          {
            job: otherJob.identity,
            payload: { value: 'second-identity' },
            idempotencyKey: 'same-key',
            runAt: now,
            attemptsMax: 1,
            now
          }
        ])
      )
      expect(result.map((item) => item.duplicate)).toEqual([false, false])
      expect(result[0]?.job.name === 'redis-job').toBe(true)
      expect(result[1]?.job.name === 'redis-other').toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  integration('settles identical concurrent acknowledgements idempotently', async () => {
    const namespace = `settlement-race-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const now = Date.now()
      const enqueued = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'settlement-race' },
          runAt: now,
          attemptsMax: 1,
          now
        })
      )
      const claimed = unwrap(
        await store.claim({
          queue: queueName,
          workerId: settlementWorkerId,
          accepted: [job.identity],
          limit: 1,
          leaseDurationMs: 60_000,
          now: now + 1
        })
      ).jobs[0]
      if (claimed === undefined) throw new Error('expected a claimed job')
      const requests = Array.from({ length: 2 }, () =>
        store.settle({
          jobId: enqueued.job.id,
          leaseToken: claimed.leaseToken,
          outcome: { type: 'complete' },
          now: now + 2
        })
      )
      const results = await Promise.all(requests.map((request) => Promise.resolve(request)))
      expect(results.map((result) => unwrap(result).status).sort()).toEqual([
        'already-applied',
        'applied'
      ])
      expect(unwrap(await store.getAttempts({ jobId: enqueued.job.id }))).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  integration('rejects claim clock regressions without mutating the waiting job', async () => {
    const namespace = `claim-clock-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const enqueued = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'clock-regression' },
          runAt: 0,
          attemptsMax: 1,
          now: 100
        })
      )
      const result = await store.claim({
        queue: queueName,
        workerId: makeWorkerId('clock-worker').unwrap(),
        accepted: [job.identity],
        limit: 1,
        leaseDurationMs: 10,
        now: 99
      })
      expect(result.isErr()).toBe(true)
      const found = unwrap(await store.getJob({ jobId: enqueued.job.id }))
      expect(found).toMatchObject({ state: 'waiting', updatedAt: 100 })
    } finally {
      await runtime.dispose()
    }
  })

  integration('rejects removal with a regressed operation timestamp', async () => {
    const namespace = `remove-clock-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const enqueued = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'remove-clock-regression' },
          runAt: 100,
          attemptsMax: 1,
          now: 100
        })
      )
      const result = await store.remove({ jobId: enqueued.job.id, now: 99 })
      expect(result.isErr()).toBe(true)
      expect(unwrap(await store.getJob({ jobId: enqueued.job.id }))).not.toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  integration('heals stale active scores while recovering expired jobs', async () => {
    const namespace = `stale-active-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    let inspector: Awaited<ReturnType<typeof createRedisClientFromConfig>> | undefined
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const live = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'live-active' },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
      )
      const expired = unwrap(
        await store.enqueue({
          job: otherJob.identity,
          payload: { value: 'expired-active' },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
      )
      const first = unwrap(
        await store.claim({
          queue: queueName,
          accepted: [job.identity, otherJob.identity],
          workerId: makeWorkerId('stale-live-worker').unwrap(),
          limit: 1,
          leaseDurationMs: 100,
          now: 1
        })
      ).jobs[0]
      const second = unwrap(
        await store.claim({
          queue: queueName,
          accepted: [job.identity, otherJob.identity],
          workerId: makeWorkerId('stale-expired-worker').unwrap(),
          limit: 1,
          leaseDurationMs: 1,
          now: 1
        })
      ).jobs[0]
      if (first === undefined || second === undefined) throw new Error('expected two active jobs')
      const liveId = first.id === live.job.id ? first.id : second.id
      const expiredId = first.id === expired.job.id ? first.id : second.id
      const liveExpiry = first.id === liveId ? first.leaseExpiresAt : second.leaseExpiresAt
      if (liveExpiry === undefined) throw new Error('expected a live lease expiry')

      inspector = await createRedisClientFromConfig(config(namespace))
      await inspector.initialize()
      await sendRedisCommand(inspector.client, ['ZADD', inspector.layout.active, '0', liveId])
      const recovered = unwrap(await store.recoverStalled({ maxStalledCount: 0, now: 10 }))
      expect(recovered.recovered).toBe(1)
      expect(recovered.transitions[0]?.record.id).toBe(expiredId)
      expect(
        String(
          await sendRedisCommand(inspector.client, ['ZSCORE', inspector.layout.active, liveId])
        )
      ).toBe(String(liveExpiry))
    } finally {
      await inspector?.dispose()
      await runtime.dispose()
    }
  })

  integration('allows zero stalled budget and terminalizes the first recovery', async () => {
    const namespace = `stall-zero-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const enqueued = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'stall-zero' },
          runAt: 0,
          attemptsMax: 1,
          now: 100
        })
      )
      const claimed = unwrap(
        await store.claim({
          queue: queueName,
          workerId: makeWorkerId('stall-zero-worker').unwrap(),
          accepted: [job.identity],
          limit: 1,
          leaseDurationMs: 10,
          now: 101
        })
      ).jobs[0]
      if (claimed === undefined) throw new Error('expected a claimed job')
      const recovered = unwrap(await store.recoverStalled({ maxStalledCount: 0, now: 111 }))
      expect(recovered.recovered).toBe(1)
      expect(recovered.transitions[0]?.record.state).toBe('failed')
      expect(unwrap(await store.getJob({ jobId: enqueued.job.id }))?.state).toBe('failed')
    } finally {
      await runtime.dispose()
    }
  })

  integration('paginates unfinished jobs with a null finishedAt cursor', async () => {
    const namespace = `finished-cursor-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(config(namespace)))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const first = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'unfinished' },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
      )
      const second = unwrap(
        await store.enqueue({
          job: otherJob.identity,
          payload: { value: 'finished' },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
      )
      const claimed = unwrap(
        await store.claim({
          queue: queueName,
          accepted: [job.identity, otherJob.identity],
          workerId: makeWorkerId('finished-cursor-worker').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          now: 1
        })
      ).jobs[0]
      if (claimed === undefined) throw new Error('expected a claimed job')
      unwrap(
        await store.settle({
          jobId: claimed.id,
          leaseToken: claimed.leaseToken,
          outcome: { type: 'complete' },
          now: 2
        })
      )
      const unfinishedId = claimed.id === first.job.id ? second.job.id : first.job.id
      const page = unwrap(await store.list({ limit: 1, orderBy: 'finishedAt', order: 'desc' }))
      expect(page.jobs).toHaveLength(1)
      expect(page.jobs[0]?.id).toBe(unfinishedId)
      expect(page.nextCursor?.value).toBe(null)
      const nextRequest: Parameters<typeof store.list>[0] =
        page.nextCursor === undefined
          ? { limit: 1, orderBy: 'finishedAt', order: 'desc' }
          : { limit: 1, orderBy: 'finishedAt', order: 'desc', cursor: page.nextCursor }
      const next = unwrap(await store.list(nextRequest))
      expect(next.jobs[0]?.id).toBe(claimed.id)
      expect(next.jobs[0]?.state).toBe('completed')
    } finally {
      await runtime.dispose()
    }
  })

  integration('supports named stores and isolates their namespaces', async () => {
    const first = JobStore.named('redis-first')
    const second = JobStore.named('redis-second')
    const runtime = await Runtime.make(
      Layer.merge(
        RedisJobStore.layerFromConfigFor(first, config(`named-${process.pid}-${sequence++}-a`)),
        RedisJobStore.layerFromConfigFor(second, config(`named-${process.pid}-${sequence++}-b`))
      )
    )
    try {
      const stores = await runtime.run(async () => ({
        first: await ServiceRuntime.resolve(first),
        second: await ServiceRuntime.resolve(second)
      }))
      expect(stores.first).not.toBe(stores.second)
      expect(stores.first.descriptor.capabilities.nativeBatchClaim).toBe(true)
      expect(stores.first.descriptor.capabilities.queueFilteredNotifications).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  integration('settles awaitWake while its durable read is pending', async () => {
    const namespace = `wake-pending-${process.pid}-${sequence++}`
    const base = await createRedisClientFromConfig(config(namespace))
    let blocked = false
    let release: (() => void) | undefined
    const releaseRead = (): void => {
      const pending = release
      release = undefined
      if (pending !== undefined) pending()
    }
    const delayedClient = {
      sendCommand(args: string[]) {
        if (blocked && args[0] === 'HGETALL' && args[1] === base.layout.wake) {
          return new Promise<unknown>((resolve, reject) => {
            release = () => {
              blocked = false
              try {
                Promise.resolve(sendRedisCommand(base.client, args, base.layout.base)).then(
                  resolve,
                  reject
                )
              } catch (cause) {
                reject(cause)
              }
            }
          })
        }
        return sendRedisCommand(base.client, args, base.layout.base)
      },
      duplicate: () => base.client.duplicate()
    }
    let runtime: Awaited<ReturnType<typeof Runtime.make>> | undefined
    try {
      await base.initialize()
      runtime = await Runtime.make(
        RedisJobStore.layer({
          // SAFETY: delayedClient implements the command and duplicate methods required by the Redis boundary.
          client: delayedClient as RedisCommandClient,
          subscriber: base.subscriber,
          namespace,
          prefix
        })
      )
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const token = unwrap(
        await store.claim({
          queue: queueName,
          accepted: [job.identity],
          workerId: makeWorkerId('wake-pending-worker').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          now: 0
        })
      ).wakeToken

      blocked = true
      const controller = new AbortController()
      const aborted = store.awaitWake({
        queues: [queueName],
        wakeToken: token,
        signal: controller.signal
      })
      controller.abort()
      expect((await aborted).isErr()).toBe(true)
      releaseRead()

      blocked = true
      const disposed = store.awaitWake({
        queues: [queueName],
        wakeToken: token,
        signal: new AbortController().signal
      })
      await runtime.dispose()
      expect((await disposed).isErr()).toBe(true)
      releaseRead()
    } finally {
      blocked = false
      releaseRead()
      if (runtime !== undefined) await runtime.dispose()
      await base.dispose()
    }
  })
})
