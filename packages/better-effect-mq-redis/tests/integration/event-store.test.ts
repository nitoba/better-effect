import { describe, expect, test } from 'bun:test'
import {
  JobEventStore,
  JobStore,
  Queue,
  Codec,
  makeQueueName,
  makeWorkerId
} from 'better-effect-mq'
import { Runtime, ServiceRuntime } from 'better-effect'
import type { Result as ResultType } from 'better-result'
import { RedisJobStore } from '../../src'

const url = process.env.REDIS_URL
const integration = url === undefined ? test.skip : test
let sequence = 0

const queue = Queue.define('redis-events')
const job = queue.job('event-job', {
  version: 1,
  payload: Codec.json<{ readonly value: string }>()
})
const queueName = makeQueueName(queue.name).unwrap()

const unwrap = <Value, Failure>(
  result: ResultType<Value, Failure> | PromiseLike<ResultType<Value, Failure>>
): Value => {
  // The core operation type permits synchronous adapters; Redis returns a PromiseLike.
  // SAFETY: Redis adapter operations resolve to a Result before this helper is called.
  const resolved = result as ResultType<Value, Failure>
  if (resolved.isErr()) throw resolved.error
  return resolved.value
}

const config = (namespace: string) => {
  const base = {
    namespace,
    prefix: `better-effect-mq-events-${process.pid}`,
    validateLayout: true
  }
  return url === undefined ? base : { ...base, url }
}

describe('RedisJobEventStore public integration', () => {
  integration('appends a safe enqueue event in the event-enabled layer', async () => {
    const namespace = `events-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(
      RedisJobStore.layerWithEventsFromConfig(config(namespace), { retention: { count: 128 } })
    )
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const events = await runtime.run(() => ServiceRuntime.resolve(JobEventStore))
      const before = unwrap(await events.tailCursor())
      const now = Date.now()
      const enqueued = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'safe-event' },
          metadata: { secret: 'must-not-be-recorded' },
          runAt: now,
          attemptsMax: 1,
          now
        })
      )
      expect(enqueued.duplicate).toBe(false)

      const page = unwrap(await events.read({ after: before, limit: 10 }))
      expect(page.events).toHaveLength(1)
      expect(page.events[0]).toMatchObject({
        type: 'job-enqueued',
        jobId: enqueued.job.id,
        queue: queueName,
        name: job.name,
        version: job.version,
        state: 'waiting',
        duplicate: false
      })
      expect(JSON.stringify(page.events[0])).not.toContain('must-not-be-recorded')
      expect(JSON.stringify(page.events[0])).not.toContain('safe-event')
    } finally {
      await runtime.dispose()
    }
  })

  integration('uses exclusive cursors and keeps filters in the reader', async () => {
    const namespace = `filters-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerWithEventsFromConfig(config(namespace)))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const events = await runtime.run(() => ServiceRuntime.resolve(JobEventStore))
      const before = unwrap(await events.tailCursor())
      const now = Date.now()
      const first = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'first' },
          runAt: now,
          attemptsMax: 1,
          now
        })
      )
      const second = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'second' },
          runAt: now,
          attemptsMax: 1,
          now
        })
      )
      const page = unwrap(await events.read({ after: before, queues: [queueName], limit: 1 }))
      expect(page.events).toHaveLength(1)
      expect(page.events[0]?.jobId).toBe(first.job.id)
      const all = unwrap(await events.read({ after: before, jobId: first.job.id, limit: 10 }))
      expect(all.events.every((event) => event.jobId === first.job.id)).toBe(true)
      expect(second.job.id).not.toBe(first.job.id)
    } finally {
      await runtime.dispose()
    }
  })

  integration('records atomic lifecycle events and wakes event waiters', async () => {
    const namespace = `lifecycle-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(
      RedisJobStore.layerWithEventsFromConfig(config(namespace), { retention: { count: 32 } })
    )
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const events = await runtime.run(() => ServiceRuntime.resolve(JobEventStore))
      const before = unwrap(await events.tailCursor())
      const signal = new AbortController()
      const waiting = events.awaitEvents({ after: before, signal: signal.signal })
      const now = Date.now()
      const enqueued = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'lifecycle' },
          runAt: now,
          attemptsMax: 1,
          now
        })
      )
      const claimed = unwrap(
        await store.claim({
          queue: queueName,
          accepted: [job.identity],
          workerId: makeWorkerId('event-worker').unwrap(),
          limit: 1,
          leaseDurationMs: 10_000,
          now: now + 1
        })
      ).jobs[0]
      if (claimed === undefined) throw new Error('expected a claimed job')
      unwrap(
        await store.settle({
          jobId: claimed.id,
          leaseToken: claimed.leaseToken,
          outcome: { type: 'complete' },
          now: now + 2
        })
      )
      unwrap(await store.pause({ queue: queueName, now: now + 3 }))
      unwrap(await store.resume({ queue: queueName, now: now + 4 }))
      expect(unwrap(await waiting)).toBeUndefined()

      const page = unwrap(await events.read({ after: before, limit: 32 }))
      expect(page.events.map((event) => event.type)).toEqual([
        'job-enqueued',
        'job-claimed',
        'job-completed',
        'queue-paused',
        'queue-resumed'
      ])
      expect(page.events[0]?.jobId).toBe(enqueued.job.id)
      expect(page.events[2]?.outcome).toBe('completed')
    } finally {
      await runtime.dispose()
    }
  })

  integration('applies stream retention and reports expired cursors', async () => {
    const namespace = `retention-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(
      RedisJobStore.layerWithEventsFromConfig(config(namespace), { retention: { count: 2 } })
    )
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const events = await runtime.run(() => ServiceRuntime.resolve(JobEventStore))
      const before = unwrap(await events.tailCursor())
      const now = Date.now()
      await store.enqueueMany([
        {
          job: job.identity,
          payload: { value: 'retention-1' },
          runAt: now,
          attemptsMax: 1,
          now
        },
        {
          job: job.identity,
          payload: { value: 'retention-2' },
          runAt: now,
          attemptsMax: 1,
          now
        },
        {
          job: job.identity,
          payload: { value: 'retention-3' },
          runAt: now,
          attemptsMax: 1,
          now
        }
      ])
      const expired = await events.read({ after: before, limit: 10 })
      expect(expired.isErr()).toBe(true)
      const tail = unwrap(await events.tailCursor())
      const retained = unwrap(await events.read({ after: tail, limit: 10 }))
      expect(retained.events).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  integration('covers administrative, recovery, and cancellation transitions', async () => {
    const namespace = `admin-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(RedisJobStore.layerWithEventsFromConfig(config(namespace)))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const events = await runtime.run(() => ServiceRuntime.resolve(JobEventStore))
      const before = unwrap(await events.tailCursor())
      const now = Date.now()

      const delayed = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'admin' },
          runAt: now + 100,
          attemptsMax: 1,
          now
        })
      )
      unwrap(await store.promote({ jobId: delayed.job.id, now: now + 1 }))
      unwrap(await store.cancel({ jobId: delayed.job.id, now: now + 2 }))
      unwrap(await store.retry({ jobId: delayed.job.id, runAt: now + 3, now: now + 3 }))
      unwrap(await store.remove({ jobId: delayed.job.id, now: now + 4 }))

      const stalled = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'stalled' },
          runAt: now,
          attemptsMax: 1,
          now: now + 5
        })
      )
      const claimedStalled = unwrap(
        await store.claim({
          queue: queueName,
          accepted: [job.identity],
          workerId: makeWorkerId('stalled-event-worker').unwrap(),
          limit: 1,
          leaseDurationMs: 1,
          now: now + 6
        })
      ).jobs.find((candidate) => candidate.id === stalled.job.id)
      expect(claimedStalled?.id).toBe(stalled.job.id)
      unwrap(await store.recoverStalled({ maxStalledCount: 0, now: now + 8 }))

      const cancellable = unwrap(
        await store.enqueue({
          job: job.identity,
          payload: { value: 'cancel-request' },
          runAt: now + 9,
          attemptsMax: 1,
          now: now + 9
        })
      )
      const claimedCancellable = unwrap(
        await store.claim({
          queue: queueName,
          accepted: [job.identity],
          workerId: makeWorkerId('cancel-event-worker').unwrap(),
          limit: 1,
          leaseDurationMs: 100,
          now: now + 10
        })
      ).jobs.find((candidate) => candidate.id === cancellable.job.id)
      if (claimedCancellable === undefined) throw new Error('expected a cancellable job')
      unwrap(await store.requestCancellation({ jobId: cancellable.job.id, now: now + 11 }))
      unwrap(
        await store.release({
          jobId: cancellable.job.id,
          leaseToken: claimedCancellable.leaseToken,
          now: now + 12
        })
      )

      const page = unwrap(await events.read({ after: before, limit: 32 }))
      expect(page.events.map((event) => event.type)).toEqual([
        'job-enqueued',
        'job-promoted',
        'job-cancelled',
        'job-admin-retried',
        'job-removed',
        'job-enqueued',
        'job-claimed',
        'job-stalled-recovered',
        'job-enqueued',
        'job-claimed',
        'job-cancel-requested',
        'job-released'
      ])
    } finally {
      await runtime.dispose()
    }
  })
})
