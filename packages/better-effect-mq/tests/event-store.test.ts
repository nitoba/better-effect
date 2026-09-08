import { expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'

import {
  JobEventCursorExpiredError,
  JobEventStore,
  JobEventWriterRejectedError,
  JobId,
  JobName,
  JobStore,
  MemoryJobEventStore,
  MemoryJobStore,
  QueueName,
  WorkerId,
  assertDurableJobEventType,
  durableJobEventTaxonomies,
  durableJobEventTypeDescriptors,
  durableJobEventTypes,
  isDurableJobEventType,
  type JobStoreError,
  type JobStoreOperation
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

test('durable event taxonomy describes the versioned extension operations', () => {
  expect(durableJobEventTypes).toHaveLength(30)
  expect(durableJobEventTypes.slice(0, 14)).toEqual([
    'job-enqueued',
    'job-claimed',
    'job-completed',
    'job-retry-scheduled',
    'job-failed',
    'job-cancelled',
    'job-cancel-requested',
    'job-released',
    'job-stalled-recovered',
    'job-promoted',
    'job-admin-retried',
    'job-removed',
    'queue-paused',
    'queue-resumed'
  ])
  expect(durableJobEventTaxonomies.flowV2.types).toEqual([
    'flow-fan-out',
    'flow-child-results-recorded',
    'flow-cancelled',
    'flow-cascaded',
    'flow-outbox-appended'
  ])
  expect(durableJobEventTaxonomies.scheduleV1.types).toEqual([
    'schedule-upserted',
    'schedule-removed',
    'schedule-ticked',
    'schedule-paused',
    'schedule-resumed'
  ])
  expect(durableJobEventTaxonomies.controlsV3.types).toEqual([
    'controls-reconciled',
    'controls-claimed',
    'controls-settled',
    'controls-released',
    'controls-stalled-recovered',
    'controls-cancelled'
  ])

  expect(durableJobEventTypeDescriptors).toHaveLength(durableJobEventTypes.length)
  expect(
    durableJobEventTypeDescriptors.filter(
      ({ family, protocolVersion }) => family === 'flow' && protocolVersion === 2
    )
  ).toHaveLength(5)
  expect(
    durableJobEventTypeDescriptors.filter(
      ({ family, protocolVersion }) => family === 'schedule' && protocolVersion === 1
    )
  ).toHaveLength(5)
  expect(
    durableJobEventTypeDescriptors.filter(
      ({ family, protocolVersion }) => family === 'controls' && protocolVersion === 3
    )
  ).toHaveLength(6)
  expect(
    durableJobEventTypeDescriptors
      .filter(({ family }) => family === 'flow')
      .map(({ operation }) => operation)
  ).toEqual(['fanOut', 'recordChildResults', 'cancel', 'markCascaded', 'outbox'])
  expect(Object.isFrozen(durableJobEventTypes)).toBe(true)
  expect(Object.isFrozen(durableJobEventTaxonomies.flowV2)).toBe(true)
  expect(Object.isFrozen(durableJobEventTypeDescriptors)).toBe(true)
  expect(Object.isFrozen(durableJobEventTypeDescriptors[0])).toBe(true)
})

test('durable event type validation accepts the taxonomy and rejects unknown values', () => {
  expect(isDurableJobEventType('flow-fan-out')).toBe(true)
  expect(isDurableJobEventType('schedule-ticked')).toBe(true)
  expect(isDurableJobEventType('controls-settled')).toBe(true)
  expect(isDurableJobEventType('flow-started')).toBe(false)
  expect(assertDurableJobEventType('flow-fan-out')).toBe('flow-fan-out')
  expect(() => assertDurableJobEventType('flow-started')).toThrow(
    'event type is not a supported durable job event type'
  )

  const events = MemoryJobEventStore.make()
  expect(unwrap(events.read({ types: ['flow-fan-out'] })).events).toEqual([])
  // SAFETY: MemoryJobEventStore.read is synchronous even though adapters may return a PromiseLike.
  const invalid = events.read({ types: ['flow-started' as never] }) as Result<unknown, unknown>
  expect(Result.isError(invalid)).toBe(true)
})

const request = (id: string, now = 0) => ({
  id: JobId.make(id).unwrap(),
  job: identity,
  payload: { email: 'redacted@example.com' },
  metadata: { secret: 'must-not-leak' },
  runAt: now,
  attemptsMax: 2,
  now
})

const resolveStoreOperation = async <Value>(
  operation: JobStoreOperation<Value, JobStoreError>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

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

test('event rollout activates optional state with a stable cursor and never auto-requires', () => {
  const events = MemoryJobEventStore.make()
  const initial = unwrap(events.tailCursor())
  expect(unwrap(events.activation())).toMatchObject({
    state: 'inactive',
    activationCursor: undefined,
    revision: 0
  })

  const jobs = MemoryJobStore.make({ eventStore: events })
  unwrap(jobs.enqueue(request('rollout-job')))
  const optional = unwrap(events.activation())
  expect(optional.state).toBe('optional')
  expect(optional.activationCursor).toBe(initial)
  expect(optional.revision).toBe(1)

  const repeatedOptional = unwrap(events.activate({ mode: 'optional', now: 1 }))
  expect(repeatedOptional).toEqual(optional)
  expect(unwrap(events.readiness({ id: 'current', version: '1', canAppend: true }))).toMatchObject({
    ready: true,
    reason: 'optional'
  })
})

test('required activation rejects an old writer before it can mutate the store', async () => {
  const events = MemoryJobEventStore.make()
  unwrap(events.activate({ mode: 'required', now: 0 }))
  const oldWriter = MemoryJobStore.make({
    eventStore: events,
    eventWriter: { id: 'old-worker', version: '0', canAppend: false }
  })

  let failure: unknown
  try {
    await resolveStoreOperation(oldWriter.enqueue(request('rejected-job')))
  } catch (cause) {
    failure = cause
  }
  expect(failure).toBeInstanceOf(JobEventWriterRejectedError)
  expect(unwrap(oldWriter.getJob({ jobId: JobId.make('rejected-job').unwrap() }))).toBeUndefined()
  expect(unwrap(events.read({})).events).toHaveLength(0)
  expect(unwrap(events.activate({ mode: 'required', now: 1 }))).toMatchObject({
    state: 'required',
    revision: 1
  })
})
