import { expect, test } from 'bun:test'

import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

import { JobName, JobStore, MemoryJobStore, QueueName, makeJobId, type JobIdentity } from '../src'
import {
  JobScheduleStore,
  MemoryJobScheduleStore,
  ScheduleNotFoundError,
  type ScheduleRecord,
  type TickScheduleCommand
} from '../src/schedule'

const resolve = async <Value, Failure>(
  operation: ResultType<Value, Failure> | PromiseLike<ResultType<Value, Failure>>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const identity = {
  queue: QueueName.make('billing').unwrap(),
  name: JobName.make('invoice').unwrap(),
  version: 2
} satisfies JobIdentity

const record = (overrides: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  key: 'monthly',
  group: 'billing',
  job: identity,
  queue: identity.queue,
  cron: '0 0 1 * *',
  everyMs: undefined,
  timeZone: 'UTC',
  payload: { month: 'current' },
  metadata: { source: 'test' },
  priority: 4,
  attemptsMax: 3,
  backoff: undefined,
  timeoutMs: 10_000,
  misfire: { strategy: 'run-once' },
  overlap: 'allow',
  paused: false,
  revision: 1,
  nextRunAtMs: 2_000,
  lastScheduledAtMs: undefined,
  lastJobId: undefined,
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
  ...overrides
})

const tick = (overrides: Partial<TickScheduleCommand> = {}): TickScheduleCommand => ({
  key: 'monthly',
  expectedRevision: 1,
  expectedRunAtMs: 2_000,
  nowMs: 2_001,
  decision: {
    occurrences: [2_000],
    nextRunAtMs: 3_000
  },
  ...overrides
})

test('MemoryJobScheduleStore keeps idempotent upserts and rejects invalid records', async () => {
  const jobStore = MemoryJobStore.make()
  const schedules = MemoryJobScheduleStore.make({ jobStore })
  const first = await resolve(schedules.upsertSchedule(record()))
  const second = await resolve(schedules.upsertSchedule({ ...record(), updatedAtMs: 9_000 }))

  expect(first.created).toBe(true)
  expect(second.created).toBe(false)
  expect(second.changed).toBe(false)
  expect(second.record.revision).toBe(first.record.revision)
  expect(second.record.nextRunAtMs).toBe(first.record.nextRunAtMs)
  expect(second.record.updatedAtMs).toBe(first.record.updatedAtMs)

  const invalid = await schedules.upsertSchedule(record({ everyMs: 1_000 }))
  expect(Result.isError(invalid)).toBe(true)
  if (Result.isError(invalid)) expect(invalid.error.name).toBe('ScheduleDefinitionError')
})

test('MemoryJobScheduleStore isolates named JobStore associations', async () => {
  const Named = JobStore.named('durable')
  const DefaultSchedules = JobScheduleStore.for(JobStore)
  const NamedSchedules = JobScheduleStore.for(Named)

  expect(DefaultSchedules.serviceTag).not.toBe(NamedSchedules.serviceTag)
  expect(DefaultSchedules.jobStore).toBe(JobStore)
  expect(NamedSchedules.jobStore).toBe(Named)

  const defaultStore = MemoryJobStore.make()
  const namedStore = MemoryJobStore.make()
  const defaultSchedules = MemoryJobScheduleStore.make({ jobStore: defaultStore })
  const namedSchedules = MemoryJobScheduleStore.make({ jobStore: namedStore })

  await resolve(defaultSchedules.upsertSchedule(record({ key: 'default' })))
  await resolve(namedSchedules.upsertSchedule(record({ key: 'named' })))

  expect((await resolve(defaultSchedules.listSchedules({}))).map((item) => item.key)).toEqual([
    'default'
  ])
  expect((await resolve(namedSchedules.listSchedules({}))).map((item) => item.key)).toEqual([
    'named'
  ])
})

test('tickSchedule CAS-enqueues a deterministic occurrence before advancing', async () => {
  const jobStore = MemoryJobStore.make()
  const schedules = MemoryJobScheduleStore.make({ jobStore })
  await resolve(schedules.upsertSchedule(record()))

  const [first, second] = await Promise.all([
    resolve(schedules.tickSchedule(tick())),
    resolve(schedules.tickSchedule(tick()))
  ])
  const fired = first.status === 'fired' ? first : second
  const stale = first.status === 'stale' ? first : second
  const checkedJobId = makeJobId('sched/billing/monthly/2000')
  if (Result.isError(checkedJobId)) throw checkedJobId.error
  const jobId = checkedJobId.value

  expect(fired.status).toBe('fired')
  expect(fired.jobs).toHaveLength(1)
  expect(fired.jobs[0]?.id).toBe(jobId)
  expect(fired.schedule.nextRunAtMs).toBe(3_000)
  expect(stale.status).toBe('stale')
  expect((await resolve(jobStore.getJob({ jobId })))?.id).toBe(jobId)
  expect((await resolve(jobStore.counts())).total).toBe(1)
})

test('tickSchedule leaves the schedule unchanged when enqueue rejects the timestamp', async () => {
  const jobStore = MemoryJobStore.make({ clock: () => 2_000 })
  const schedules = MemoryJobScheduleStore.make({ jobStore })
  await resolve(schedules.upsertSchedule(record()))

  const failed = await schedules.tickSchedule(tick({ nowMs: 2_001 }))
  expect(Result.isError(failed)).toBe(true)
  expect((await resolve(schedules.getSchedule('monthly')))?.revision).toBe(1)
  expect((await resolve(schedules.getSchedule('monthly')))?.nextRunAtMs).toBe(2_000)
  expect((await resolve(jobStore.counts())).total).toBe(0)
})

test('tickSchedule returns paused, due records are sorted, and pause/resume are typed', async () => {
  const schedules = MemoryJobScheduleStore.make({ jobStore: MemoryJobStore.make() })
  await resolve(schedules.upsertSchedule(record({ key: 'later', nextRunAtMs: 5_000 })))
  await resolve(schedules.upsertSchedule(record({ key: 'first', nextRunAtMs: 1_000 })))
  await resolve(schedules.pauseSchedule('first'))

  const paused = await resolve(
    schedules.tickSchedule(tick({ key: 'first', expectedRunAtMs: 1_000 }))
  )
  expect(paused.status).toBe('paused')
  expect((await resolve(schedules.dueSchedules({ nowMs: 6_000 }))).map((item) => item.key)).toEqual(
    ['later']
  )

  await resolve(schedules.resumeSchedule('first'))
  expect((await resolve(schedules.getSchedule('first')))?.paused).toBe(false)
  const missing = await schedules.pauseSchedule('missing')
  expect(Result.isError(missing)).toBe(true)
  if (Result.isError(missing)) expect(missing.error).toBeInstanceOf(ScheduleNotFoundError)
})

test('MemoryJobScheduleStore.layer resolves the associated default JobStore', async () => {
  const runtime = await Runtime.make(
    Layer.merge(MemoryJobStore.layer, MemoryJobScheduleStore.layer)
  )
  try {
    const scheduleStore = await runtime.run(() => ServiceRuntime.resolve(JobScheduleStore))
    const jobStore = await runtime.run(() => ServiceRuntime.resolve(JobStore))
    await resolve(scheduleStore.upsertSchedule(record()))
    const fired = await resolve(scheduleStore.tickSchedule(tick()))

    expect(fired.jobs).toHaveLength(1)
    expect((await resolve(jobStore.counts())).total).toBe(1)
  } finally {
    await runtime.dispose()
  }
})
