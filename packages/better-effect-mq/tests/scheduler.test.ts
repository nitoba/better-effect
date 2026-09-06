import { expect, test } from 'bun:test'

import { Effect, Layer, Runtime } from 'better-effect'
import { Clock, ClockTest } from 'better-effect/standard-services'
import { Result, type Result as ResultType } from 'better-result'

import {
  Codec,
  JobScheduleStore,
  JobSchedules,
  JobStore,
  MemoryJobScheduleStore,
  MemoryJobStore,
  Queue,
  QueueName,
  type ScheduleRecord
} from '../src'

const resolve = async <Value, Failure>(
  operation: ResultType<Value, Failure> | PromiseLike<ResultType<Value, Failure>>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const job = Queue.define('scheduler-tests').job('run', {
  version: 1,
  payload: Codec.json<{ readonly value: number }>()
})

const record = (overrides: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  key: 'removed',
  group: 'billing',
  job: job.identity,
  queue: QueueName.make('scheduler-tests').unwrap(),
  cron: undefined,
  everyMs: 1_000,
  timeZone: 'UTC',
  payload: { value: 0 },
  metadata: {},
  priority: 0,
  attemptsMax: 1,
  backoff: undefined,
  timeoutMs: undefined,
  misfire: { strategy: 'run-once' },
  overlap: 'allow',
  paused: false,
  revision: 0,
  nextRunAtMs: 1_000,
  lastScheduledAtMs: undefined,
  lastJobId: undefined,
  createdAtMs: 0,
  updatedAtMs: 0,
  ...overrides
})

test('JobSchedules.reconcile is yieldable, encodes before upserting, and scopes removals by group', async () => {
  const jobStore = MemoryJobStore.make()
  const scheduleStore = MemoryJobScheduleStore.make({ jobStore })
  await resolve(scheduleStore.upsertSchedule(record()))

  const desired = JobSchedules.define({
    group: 'billing',
    schedules: [
      JobSchedules.schedule(job, 'daily', {
        everyMs: 1_000,
        payload: { value: 1 }
      })
    ],
    stores: [JobStore]
  })
  const layer = Layer.merge(
    Layer.succeed(JobStore, JobStore.of(jobStore)),
    Layer.merge(
      Layer.succeed(JobScheduleStore, JobScheduleStore.of(scheduleStore)),
      Layer.succeed(Clock, new ClockTest(0))
    )
  )
  const runtime = await Runtime.make(layer)

  try {
    const warned = await runtime.run(() =>
      Effect.gen(async function* () {
        const report = yield* JobSchedules.reconcile(desired, {
          nowMs: 0,
          removal: 'warn'
        })
        return Result.ok(report)
      })
    )

    if (Result.isError(warned)) throw warned.error
    expect(warned.value.created).toHaveLength(1)
    expect(warned.value.warned).toEqual([{ group: 'billing', key: 'removed' }])
    expect((await resolve(scheduleStore.getSchedule('removed')))?.key).toBe('removed')

    const removed = await runtime.run(() =>
      Effect.gen(async function* () {
        const report = yield* JobSchedules.reconcile(desired, {
          nowMs: 0,
          removal: 'group'
        })
        return Result.ok(report)
      })
    )

    if (Result.isError(removed)) throw removed.error
    expect(removed.value.removed).toEqual([{ group: 'billing', key: 'removed' }])
    expect(await resolve(scheduleStore.getSchedule('removed'))).toBeUndefined()
  } finally {
    await runtime.dispose()
  }
})

test('reconciliation grace is Clock-driven and completes before removal', async () => {
  const clock = new ClockTest(0)
  const jobStore = MemoryJobStore.make()
  const scheduleStore = MemoryJobScheduleStore.make({ jobStore })
  await resolve(scheduleStore.upsertSchedule(record()))

  const desired = JobSchedules.define({
    group: 'billing',
    schedules: [],
    stores: [JobStore]
  })
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(jobStore)),
      Layer.succeed(JobScheduleStore, JobScheduleStore.of(scheduleStore)),
      Layer.succeed(Clock, clock)
    )
  )

  try {
    const pending = runtime.run(() =>
      Effect.gen(async function* () {
        const report = yield* JobSchedules.reconcile(desired, {
          removal: 'group',
          removeAfterMs: 100
        })
        return Result.ok(report)
      })
    )

    await Promise.resolve()
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(clock.pendingSleeps).toBe(1)
    expect(await resolve(scheduleStore.getSchedule('removed'))).toBeDefined()

    clock.advance(100)
    const result = await pending
    if (Result.isError(result)) throw result.error
    expect(result.value.removed).toEqual([{ group: 'billing', key: 'removed' }])
    expect(await resolve(scheduleStore.getSchedule('removed'))).toBeUndefined()
  } finally {
    await runtime.dispose()
  }
})

test('JobScheduler starts with optional reconciliation, sweeps due schedules with CAS, and drains on stop', async () => {
  const clock = new ClockTest(0)
  const jobStore = MemoryJobStore.make({ clock: () => clock.now().getTime() })
  const scheduleStore = MemoryJobScheduleStore.make({ jobStore })
  const schedules = JobSchedules.define({
    group: 'billing',
    schedules: [
      JobSchedules.schedule(job, 'every-second', {
        everyMs: 100,
        payload: { value: 2 }
      })
    ],
    stores: [JobStore]
  })
  const schedulerService = (await import('../src')).JobScheduler.service('BillingScheduler')
  const schedulerLayer = schedulerService.layer(() => ({
    registries: [schedules] as const,
    sweepIntervalMs: 1_000,
    batchSize: 10,
    startupReconcile: true
  }))
  const runtime = await Runtime.make(
    Layer.complete(
      Layer.merge(
        Layer.merge(
          Layer.succeed(JobStore, JobStore.of(jobStore)),
          Layer.succeed(JobScheduleStore, JobScheduleStore.of(scheduleStore))
        ),
        Layer.merge(Layer.succeed(Clock, clock), schedulerLayer)
      )
    ),
    { warmup: true }
  )

  try {
    const resolved = await runtime.run(() =>
      Effect.gen(async function* () {
        return Result.ok(yield* schedulerService)
      })
    )
    if (Result.isError(resolved)) throw resolved.error

    const first = await resolve(
      scheduleStore.getSchedule({ group: 'billing', key: 'every-second' })
    )
    expect(first?.nextRunAtMs).toBe(100)

    clock.advance(100)
    await resolved.value.sweep()
    expect((await resolve(jobStore.counts())).total).toBe(1)

    resolved.value.quiesce()
    clock.advance(100)
    await resolved.value.sweep()
    expect((await resolve(jobStore.counts())).total).toBe(1)
  } finally {
    await runtime.dispose()
  }
})
