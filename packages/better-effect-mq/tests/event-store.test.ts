import { expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'

import {
  JobEventCursorExpiredError,
  JobEventStore,
  JobId,
  JobName,
  JobStore,
  MemoryJobEventStore,
  MemoryJobStore,
  QueueName,
  WorkerId
} from '../src'

const unwrap = <Value, Failure>(
  value: Result<Value, Failure> | PromiseLike<Result<Value, Failure>>
): Value => {
  // Memory operations are synchronous except for their explicit wait boundary.
  // SAFETY: synchronous Memory operations return a Result; the PromiseLike branch is used only at await boundaries.
  const result = value as Result<Value, Failure>
  if (Result.isError(result)) throw result.error
  return result.value
}

const queue = QueueName.make('events').unwrap()
const name = JobName.make('send').unwrap()
const identity = { queue, name, version: 1 } as const

const request = (id: string, now = 0) => ({
  id: JobId.make(id).unwrap(),
  job: identity,
  payload: { email: 'redacted@example.com' },
  metadata: { secret: 'must-not-leak' },
  runAt: now,
  attemptsMax: 2,
  now
})

test('MemoryJobEventStore appends MemoryJobStore transitions atomically', () => {
  const events = MemoryJobEventStore.make()
  const jobs = MemoryJobStore.make({ eventStore: events })
  const created = unwrap(jobs.enqueue(request('event-job')))
  const claimed = unwrap(
    jobs.claim({
      queue,
      accepted: [identity],
      limit: 1,
      workerId: WorkerId.make('event-worker').unwrap(),
      leaseDurationMs: 100,
      now: 0
    })
  )
  unwrap(
    jobs.settle({
      jobId: created.job.id,
      leaseToken: claimed.jobs[0]!.leaseToken,
      outcome: { type: 'complete' },
      now: 0
    })
  )

  const page = unwrap(events.read({}))
  expect(page.events.map((event) => event.type)).toEqual([
    'job-enqueued',
    'job-claimed',
    'job-completed'
  ])
  expect(page.events.every((event) => event.attributes !== undefined)).toBe(true)
  expect(JSON.stringify(page.events)).not.toContain('redacted@example.com')
  expect(JSON.stringify(page.events)).not.toContain('must-not-leak')
})

test('duplicate enqueue, heartbeat, and already-applied settlement do not append duplicates', () => {
  const events = MemoryJobEventStore.make()
  const jobs = MemoryJobStore.make({ eventStore: events })
  const first = unwrap(jobs.enqueue(request('duplicate-job')))
  unwrap(jobs.enqueue(request('duplicate-job')))
  const claimed = unwrap(
    jobs.claim({
      queue,
      accepted: [identity],
      limit: 1,
      workerId: WorkerId.make('duplicate-worker').unwrap(),
      leaseDurationMs: 100,
      now: 0
    })
  )
  unwrap(
    jobs.heartbeat({
      leases: [{ jobId: first.job.id, leaseToken: claimed.jobs[0]!.leaseToken }],
      leaseDurationMs: 100,
      now: 0
    })
  )
  const settlement = {
    jobId: first.job.id,
    leaseToken: claimed.jobs[0]!.leaseToken,
    outcome: { type: 'complete' as const },
    now: 0
  }
  unwrap(jobs.settle(settlement))
  unwrap(jobs.settle(settlement))

  expect(unwrap(events.read({})).events.map((event) => event.type)).toEqual([
    'job-enqueued',
    'job-claimed',
    'job-completed'
  ])
})

test('event cursors paginate through filtered gaps and retention expires old cursors', () => {
  let now = 0
  const events = MemoryJobEventStore.make({
    clock: () => now,
    retention: { count: 2 }
  })
  const jobs = MemoryJobStore.make({ eventStore: events, clock: () => now })
  const initial = unwrap(events.tailCursor())
  unwrap(jobs.enqueue(request('first', now)))
  unwrap(jobs.enqueue(request('second', now)))
  const first = unwrap(events.read({ limit: 1, types: ['job-enqueued'] }))
  expect(first.events).toHaveLength(1)
  expect(first.nextCursor).toBeDefined()
  unwrap(jobs.enqueue(request('third', now)))
  const cursor = first.nextCursor
  if (cursor === undefined) throw new Error('missing first event cursor')
  const second = unwrap(events.read({ after: cursor, types: ['job-enqueued'] }))
  expect(second.events).toHaveLength(2)

  now = 1
  unwrap(jobs.enqueue(request('fourth', now)))
  // SAFETY: MemoryJobEventStore.read is synchronous even though its public operation permits async adapters.
  const expired = events.read({ after: initial }) as Result<unknown, unknown>
  expect(Result.isError(expired)).toBe(true)
  if (Result.isError(expired)) expect(expired.error).toBeInstanceOf(JobEventCursorExpiredError)
})

test('awaitEvents wakes only for matching queues and aborts deterministically', async () => {
  const events = MemoryJobEventStore.make()
  const jobs = MemoryJobStore.make({ eventStore: events })
  const after = unwrap(events.tailCursor())
  const controller = new AbortController()
  const waiting = events.awaitEvents({ after, queues: [queue], signal: controller.signal })
  unwrap(jobs.enqueue(request('wake-job')))
  unwrap(await waiting)

  const aborted = new AbortController()
  const pending = events.awaitEvents({
    after: unwrap(events.tailCursor()),
    signal: aborted.signal
  })
  aborted.abort()
  const result = await pending
  expect(Result.isError(result)).toBe(true)
})

test('JobEventStore is a Layer-first token associated with JobStore', async () => {
  const Durable = JobStore.named('events-layer')
  const DurableEvents = JobEventStore.for(Durable)
  const events = MemoryJobEventStore.make()
  const jobs = MemoryJobStore.make({ eventStore: events })
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(Durable, Durable.of(jobs)),
      Layer.succeed(DurableEvents, DurableEvents.of(events))
    )
  )
  try {
    const result = await runtime.run(() => ServiceRuntime.resolve(DurableEvents))
    expect(result.descriptor).toEqual(events.descriptor)
  } finally {
    await runtime.dispose()
  }
})
