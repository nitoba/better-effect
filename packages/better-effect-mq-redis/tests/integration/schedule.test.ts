import { describe, expect, test } from 'bun:test'

import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  JobEventStore,
  JobScheduleStore,
  JobStore,
  JobId,
  JobName,
  QueueName,
  makeWorkerId,
  type JobIdentity,
  type ScheduleRecord,
  type TickScheduleCommand
} from 'better-effect-mq'

import {
  RedisJobScheduleStore,
  RedisJobStore,
  type RedisJobStoreConnectionConfig
} from '../../src/index'

const url = process.env.REDIS_URL
const integration = url === undefined ? test.skip : test
const prefix = `better-effect-mq-schedule-${process.pid}`
let sequence = 0

const config = (namespace: string): RedisJobStoreConnectionConfig =>
  url === undefined
    ? { namespace, prefix, validateLayout: true }
    : { url, namespace, prefix, validateLayout: true }

const unwrap = <Value, Failure>(result: ResultType<Value, Failure>): Value => {
  if (Result.isError(result)) throw result.error
  return result.value
}

const identity = {
  queue: QueueName.make('schedule-integration').unwrap(),
  name: JobName.make('scheduled-job').unwrap(),
  version: 1
} satisfies JobIdentity

const record = (overrides: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  key: 'every-minute',
  group: 'billing',
  job: identity,
  queue: identity.queue,
  cron: undefined,
  everyMs: 60_000,
  timeZone: undefined,
  payload: { source: 'redis' },
  metadata: { suite: 'redis' },
  priority: 1,
  attemptsMax: 2,
  backoff: undefined,
  timeoutMs: undefined,
  misfire: { strategy: 'run-once' },
  overlap: 'allow',
  paused: false,
  revision: 1,
  nextRunAtMs: 1_000,
  lastScheduledAtMs: undefined,
  lastJobId: undefined,
  createdAtMs: 0,
  updatedAtMs: 0,
  ...overrides
})

const tick = (overrides: Partial<TickScheduleCommand> = {}): TickScheduleCommand => ({
  key: { group: 'billing', key: 'every-minute' },
  expectedRevision: 1,
  expectedRunAtMs: 1_000,
  nowMs: 1_001,
  decision: { occurrences: [1_000], nextRunAtMs: 61_000 },
  ...overrides
})

describe('RedisJobScheduleStore integration', () => {
  integration('persists indexes and atomically ticks into the associated JobStore', async () => {
    const namespace = `default-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(
      Layer.merge(
        RedisJobStore.layerWithEventsFromConfig(config(namespace), { retention: { count: 128 } }),
        RedisJobScheduleStore.layerFromConfig(config(namespace), { retention: { count: 128 } })
      )
    )
    try {
      const schedules = await runtime.run(() => ServiceRuntime.resolve(JobScheduleStore))
      const jobs = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const events = await runtime.run(() => ServiceRuntime.resolve(JobEventStore))
      const before = unwrap(await events.tailCursor())

      const inserted = unwrap(await schedules.upsertSchedule(record()))
      expect(inserted.created).toBe(true)
      expect(unwrap(await schedules.upsertSchedule(record())).changed).toBe(false)
      expect(unwrap(await schedules.listSchedules({ group: 'billing' }))).toHaveLength(1)
      expect(unwrap(await schedules.dueSchedules({ nowMs: 2_000 }))).toHaveLength(1)

      const wakeToken = unwrap(
        await jobs.claim({
          queue: identity.queue,
          accepted: [identity],
          workerId: makeWorkerId('schedule-wake').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          now: 0
        })
      ).wakeToken
      const wakeWaiter = jobs.awaitWake({
        queues: [identity.queue],
        wakeToken,
        signal: new AbortController().signal
      })
      const fired = unwrap(await schedules.tickSchedule(tick()))
      expect(fired.status).toBe('fired')
      expect(fired.jobs).toHaveLength(1)
      expect(fired.jobs[0]?.id).toBe(JobId.make('sched/every-minute/1000').unwrap())
      expect(unwrap(await jobs.counts())).toMatchObject({ total: 1, waiting: 1 })
      expect(unwrap(await wakeWaiter)).toBeUndefined()

      const retry = unwrap(await schedules.tickSchedule(tick()))
      expect(retry.status).toBe('stale')
      expect(unwrap(await jobs.counts())).toMatchObject({ total: 1 })

      await schedules.pauseSchedule({ group: 'billing', key: 'every-minute' })
      expect(unwrap(await schedules.dueSchedules({ nowMs: 100_000 }))).toHaveLength(0)
      await schedules.resumeSchedule({ group: 'billing', key: 'every-minute' })
      expect(
        unwrap(await schedules.getSchedule({ group: 'billing', key: 'every-minute' }))
      ).toMatchObject({
        paused: false
      })
      expect(
        unwrap(await schedules.removeSchedule({ group: 'billing', key: 'every-minute' }))
      ).toBe(true)
      expect(unwrap(await schedules.getSchedule({ group: 'billing', key: 'every-minute' }))).toBe(
        undefined
      )
      expect(unwrap(await schedules.listSchedules({ group: 'billing' }))).toHaveLength(0)

      const page = unwrap(await events.read({ after: before, limit: 32 }))
      expect(page.events.map((event) => event.type)).toEqual([
        'schedule-upserted',
        'schedule-ticked',
        'schedule-paused',
        'schedule-resumed',
        'schedule-removed'
      ])
    } finally {
      await runtime.dispose()
    }
  })

  integration('uses CAS and deterministic IDs for concurrent and overlap-skip ticks', async () => {
    const namespace = `concurrent-${process.pid}-${sequence++}`
    const runtime = await Runtime.make(
      Layer.merge(
        RedisJobStore.layerFromConfig(config(namespace)),
        RedisJobScheduleStore.layerFromConfig(config(namespace))
      )
    )
    try {
      const schedules = await runtime.run(() => ServiceRuntime.resolve(JobScheduleStore))
      const jobs = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      await schedules.upsertSchedule(record({ key: 'skip-overlap', overlap: 'skip' }))

      const results = await Promise.all([
        schedules.tickSchedule(tick({ key: { group: 'billing', key: 'skip-overlap' } })),
        schedules.tickSchedule(tick({ key: { group: 'billing', key: 'skip-overlap' } }))
      ])
      expect(results.filter((result) => !Result.isError(result))).toHaveLength(2)
      const successful = results.map(unwrap)
      expect(successful.filter((result) => result.status === 'fired')).toHaveLength(1)
      expect(successful.filter((result) => result.status === 'stale')).toHaveLength(1)

      const next = unwrap(
        await schedules.tickSchedule({
          key: { group: 'billing', key: 'skip-overlap' },
          expectedRevision: 2,
          expectedRunAtMs: 61_000,
          nowMs: 61_001,
          decision: { occurrences: [61_000], nextRunAtMs: 121_000 }
        })
      )
      expect(next.status).toBe('skipped')
      expect(next.skippedSlots).toEqual([61_000])
      expect(unwrap(await jobs.counts())).toMatchObject({ total: 1 })
    } finally {
      await runtime.dispose()
    }
  })

  integration('uses the JobStore association for named namespaces', async () => {
    const namespace = `named-${process.pid}-${sequence++}`
    const Durable = JobStore.named('durable')
    const DurableSchedules = JobScheduleStore.for(Durable)
    const runtime = await Runtime.make(
      Layer.merge(
        RedisJobStore.layerFromConfigFor(Durable, config(namespace)),
        RedisJobScheduleStore.layerFromConfigFor(DurableSchedules, config(namespace))
      )
    )
    try {
      const schedules = await runtime.run(() => ServiceRuntime.resolve(DurableSchedules))
      await schedules.upsertSchedule(record({ key: 'named' }))
      expect(unwrap(await schedules.getSchedule({ group: 'billing', key: 'named' }))).toMatchObject(
        {
          key: 'named'
        }
      )
    } finally {
      await runtime.dispose()
    }
  })
})
