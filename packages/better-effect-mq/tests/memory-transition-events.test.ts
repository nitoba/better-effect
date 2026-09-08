import { expect, test } from 'bun:test'
import { MemoryJobEventStore, MemoryJobStore, Queue, QueueControls } from '../src'
import {
  JobId,
  LeaseToken,
  makeFlowChildId,
  makePreparedEnqueue,
  makeQueueName,
  makeWorkerId,
  protocolVersion
} from '../src'
import { Result, type Result as ResultType } from 'better-result'
import type { JobEventStoreContract, ScheduleRecord } from '../src'
import { MemoryJobScheduleStore } from '../src'

const resolve = async <Value, Failure = unknown>(
  operation: ResultType<Value, Failure> | PromiseLike<ResultType<Value, Failure>>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const eventTypes = async (events: JobEventStoreContract): Promise<readonly string[]> =>
  (await resolve<{ events: readonly { readonly type: string }[] }>(events.read({}))).events.map(
    (event) => event.type
  )

test('MemoryFlowStore transitions append only effective Flow v2 events', async () => {
  const events = MemoryJobEventStore.make({ clock: () => 0 })
  const store = MemoryJobStore.make({ eventStore: events })
  const identity = { queue: 'flow-events', name: 'parent', version: 1 } as const
  const parent = await resolve<{ job: { id: JobId } }>(
    store.enqueue({
      id: JobId.make('flow-parent').unwrap(),
      job: identity,
      payload: {},
      runAt: 0,
      now: 0,
      attemptsMax: 1
    })
  )
  const claimed = await resolve<{ jobs: readonly { leaseToken: LeaseToken }[] }>(
    store.claim({
      queue: makeQueueName(identity.queue).unwrap(),
      accepted: [identity],
      limit: 1,
      workerId: makeWorkerId('flow-worker').unwrap(),
      leaseDurationMs: 100,
      now: 0
    })
  )
  const childJobId = makeFlowChildId({
    parentStoreKey: 'flow-store',
    flowId: parent.job.id,
    childKey: 'child'
  }).unwrap()
  const childRequest = makePreparedEnqueue({
    protocolVersion,
    identity: { queue: identity.queue, name: 'child', version: 1 },
    id: childJobId,
    payload: {},
    metadata: {},
    priority: 0,
    runAt: 0,
    attemptsMax: 1,
    now: 0
  }).unwrap()
  const request = {
    flowId: parent.job.id,
    flowName: 'parent-flow',
    parentStoreKey: 'flow-store',
    depth: 1,
    leaseToken: claimed.jobs[0]!.leaseToken,
    failFast: false,
    children: [
      {
        childKey: 'child',
        name: 'child',
        version: 1,
        storeKey: 'child-store',
        childJobId,
        request: childRequest
      }
    ],
    now: 0
  } as const

  await resolve(store.v2.fanOut(request))
  const afterFanOut = await eventTypes(events)
  expect(afterFanOut.at(-1)).toBe('flow-fan-out')
  await resolve(store.v2.fanOut(request))
  expect((await eventTypes(events)).filter((type) => type === 'flow-fan-out')).toHaveLength(1)

  await resolve(
    store.v2.recordChildResults({
      flowId: parent.job.id,
      now: 0,
      reports: [
        {
          flowId: parent.job.id,
          childKey: 'child',
          outcome: 'completed',
          result: {},
          failure: undefined
        }
      ]
    })
  )
  expect((await eventTypes(events)).at(-1)).toBe('flow-child-results-recorded')
})

test('MemoryJobScheduleStore emits schedule events for changes, not stale or no-op calls', async () => {
  const events = MemoryJobEventStore.make({ clock: () => 0 })
  const jobStore = MemoryJobStore.make({ eventStore: events, clock: () => 0 })
  const scheduleStore = MemoryJobScheduleStore.make({ jobStore })
  const record: ScheduleRecord = {
    key: 'hourly',
    group: 'events',
    job: { queue: 'schedule-events', name: 'scheduled', version: 1 },
    queue: makeQueueName('schedule-events').unwrap(),
    cron: undefined,
    everyMs: 10,
    timeZone: 'UTC',
    payload: {},
    metadata: {},
    priority: 0,
    attemptsMax: 1,
    backoff: undefined,
    timeoutMs: undefined,
    misfire: { strategy: 'run-once' },
    overlap: 'allow',
    paused: false,
    revision: 0,
    nextRunAtMs: 10,
    lastScheduledAtMs: undefined,
    lastJobId: undefined,
    createdAtMs: 0,
    updatedAtMs: 0
  }
  await resolve(scheduleStore.upsertSchedule(record))
  const afterCreate = await eventTypes(events)
  expect(afterCreate.at(-1)).toBe('schedule-upserted')
  await resolve(scheduleStore.upsertSchedule(record))
  expect((await eventTypes(events)).filter((type) => type === 'schedule-upserted')).toHaveLength(1)

  const current = (await resolve<ScheduleRecord | undefined>(scheduleStore.getSchedule('hourly')))!
  await resolve(
    scheduleStore.tickSchedule({
      key: 'hourly',
      expectedRevision: current.revision,
      expectedRunAtMs: current.nextRunAtMs,
      nowMs: 0,
      decision: { occurrences: [], nextRunAtMs: 20 }
    })
  )
  expect((await eventTypes(events)).at(-1)).toBe('schedule-ticked')
  await resolve(scheduleStore.pauseSchedule('hourly'))
  await resolve(scheduleStore.resumeSchedule('hourly'))
  await resolve(scheduleStore.removeSchedule('hourly'))
  expect(await eventTypes(events)).toEqual([
    'schedule-upserted',
    'schedule-ticked',
    'schedule-paused',
    'schedule-resumed',
    'schedule-removed'
  ])
})

test('MemoryJobStore controlled transitions append controls events without duplicates', async () => {
  const events = MemoryJobEventStore.make({ clock: () => 0 })
  let clockNow = 0
  const store = MemoryJobStore.make({ eventStore: events, clock: () => clockNow })
  const queue = Queue.define('controls-events')
  const definition = QueueControls.define(queue, {})
  const registry = QueueControls.registry({ group: 'events', controls: [definition] })
  const identity = { queue: queue.queue, name: 'work', version: 1 } as const
  const report = await resolve<{ records: readonly { revision: number }[] }>(
    store.reconcile(registry)
  )
  expect(report.records[0]!.revision).toBe(1)
  const reconciliationEvents = await resolve<{
    events: readonly {
      readonly type: string
      readonly attributes: Readonly<Record<string, string>>
    }[]
  }>(events.read({}))
  expect(reconciliationEvents.events[0]).toMatchObject({
    type: 'controls-reconciled',
    attributes: { action: 'created' }
  })
  const created = await resolve<{ job: { id: JobId } }>(
    store.enqueue({ job: identity, payload: {}, runAt: 0, now: 0, attemptsMax: 1 })
  )
  const claimed = await resolve<{
    jobs: readonly { id: JobId; leaseToken: LeaseToken }[]
  }>(
    store.claimControlled({
      queue: makeQueueName(queue.queue).unwrap(),
      accepted: [identity],
      limit: 1,
      workerId: makeWorkerId('controls-worker').unwrap(),
      leaseDurationMs: 100,
      now: 0,
      controlsRevision: 1
    })
  )
  expect(claimed.jobs[0]!.id).toBe(created.job.id)
  await resolve(
    store.releaseControlled({
      jobId: claimed.jobs[0]!.id,
      leaseToken: claimed.jobs[0]!.leaseToken,
      now: 0,
      controlsRevision: 1
    })
  )
  await resolve(
    store.cancelControlled({
      jobId: claimed.jobs[0]!.id,
      now: 0,
      controlsRevision: 1
    })
  )
  const types = await eventTypes(events)
  expect(types).toContain('controls-reconciled')
  expect(types).toContain('controls-claimed')
  expect(types).toContain('job-claimed')
  expect(types).toContain('job-released')
  expect(types).toContain('job-cancelled')
  expect(types).toContain('controls-released')
  expect(types).toContain('controls-cancelled')
  expect(types.filter((type) => type === 'controls-reconciled')).toHaveLength(1)

  const settled = await resolve<{ job: { id: JobId } }>(
    store.enqueue({ job: identity, payload: {}, runAt: 0, now: 0, attemptsMax: 1 })
  )
  const settledClaim = await resolve<{
    jobs: readonly { id: JobId; leaseToken: LeaseToken }[]
  }>(
    store.claimControlled({
      queue: makeQueueName(queue.queue).unwrap(),
      accepted: [identity],
      limit: 1,
      workerId: makeWorkerId('settle-worker').unwrap(),
      leaseDurationMs: 100,
      now: 0,
      controlsRevision: 1
    })
  )
  expect(settledClaim.jobs[0]!.id).toBe(settled.job.id)
  await resolve(
    store.settleControlled({
      jobId: settled.job.id,
      leaseToken: settledClaim.jobs[0]!.leaseToken,
      outcome: { type: 'complete' },
      now: 0,
      controlsRevision: 1
    })
  )

  const stalled = await resolve<{ job: { id: JobId } }>(
    store.enqueue({ job: identity, payload: {}, runAt: 0, now: 0, attemptsMax: 2 })
  )
  const stalledClaim = await resolve<{
    jobs: readonly { id: JobId; leaseToken: LeaseToken }[]
  }>(
    store.claimControlled({
      queue: makeQueueName(queue.queue).unwrap(),
      accepted: [identity],
      limit: 1,
      workerId: makeWorkerId('stalled-worker').unwrap(),
      leaseDurationMs: 1,
      now: 0,
      controlsRevision: 1
    })
  )
  expect(stalledClaim.jobs[0]!.id).toBe(stalled.job.id)
  clockNow = 1
  await resolve(
    store.recoverStalledControlled({
      queue: makeQueueName(queue.queue).unwrap(),
      maxStalledCount: 1,
      now: 1,
      controlsRevision: 1
    })
  )

  const finalTypes = await eventTypes(events)
  expect(finalTypes).toContain('controls-settled')
  expect(finalTypes).toContain('job-completed')
  expect(finalTypes).toContain('controls-stalled-recovered')
  expect(finalTypes).toContain('job-stalled-recovered')
})
