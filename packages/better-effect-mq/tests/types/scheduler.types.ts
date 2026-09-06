import { expectTypeOf } from 'bun:test'
import { Clock } from 'better-effect/standard-services'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import type { EffectError } from 'better-effect'
import { Result } from 'better-result'

import { Codec, JobScheduleStore, JobScheduler, JobSchedules, JobStore, Queue } from '../../src'
import type { ScheduleReconcileError } from '../../src'

class SchedulerConfig extends Service<SchedulerConfig>()('SchedulerConfig') {
  readonly sweepIntervalMs!: number
}

const job = Queue.define('scheduler-types').job('run', {
  version: 1,
  payload: Codec.number
})
const schedules = JobSchedules.define({
  group: 'scheduler-types',
  schedules: [
    JobSchedules.schedule(job, 'every', {
      everyMs: 1_000,
      payload: 1
    })
  ]
})

const scheduler = JobScheduler.service('TypedScheduler')
const layer = scheduler.layer(function* () {
  const config = yield* SchedulerConfig
  return {
    registries: [schedules] as const,
    sweepIntervalMs: config.sweepIntervalMs
  }
})

expectTypeOf<Layer.Required<typeof layer>>().toEqualTypeOf<
  SchedulerConfig | Clock | JobStore.Instance | JobScheduleStore.Instance
>()
expectTypeOf<Layer.Provided<typeof layer>>().toEqualTypeOf<
  JobScheduler.ServiceInstance<'TypedScheduler'>
>()

const reconcile = JobSchedules.reconcile(schedules, { nowMs: 0 })
expectTypeOf(reconcile).toMatchTypeOf<AsyncGenerator<unknown, unknown, unknown>>()

const program = Effect.fn(async function* () {
  const report = yield* JobSchedules.reconcile(schedules, { nowMs: 0 })
  return Result.ok(report)
})
expectTypeOf<EffectError<typeof program>>().toMatchTypeOf<ScheduleReconcileError>()

declare const complete: Runtime.For<typeof layer>
void complete

// @ts-expect-error The scheduler Layer requires its factory, Clock, and associated stores.
void Runtime.make(layer)
