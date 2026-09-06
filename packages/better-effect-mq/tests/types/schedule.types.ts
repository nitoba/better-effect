import { expectTypeOf } from 'bun:test'

import { Codec, Queue } from '../../src'
import { JobSchedules } from '../../src/schedule'
import type { JobSchedule } from '../../src/schedule'

const job = Queue.define('billing').job('generate-invoice', {
  version: 3,
  payload: Codec.json<{ readonly mode: 'daily' | 'monthly' }>()
})

const draft = JobSchedules.schedule(job, 'monthly', {
  cron: '0 0 1 * *',
  payload: { mode: 'monthly' }
})
const definitions = JobSchedules.define({ group: 'billing-service', schedules: [draft] })
const schedule = definitions.schedules[0]

expectTypeOf(draft.key).toEqualTypeOf<'monthly'>()
expectTypeOf(draft.job).toEqualTypeOf<typeof job>()
expectTypeOf(draft.payload).toEqualTypeOf<{ readonly mode: 'daily' | 'monthly' }>()
expectTypeOf(definitions.group).toEqualTypeOf<'billing-service'>()
expectTypeOf(schedule!).toEqualTypeOf<JobSchedule<typeof job, 'monthly', 'billing-service'>>()

// @ts-expect-error A schedule must choose exactly one cadence strategy.
JobSchedules.schedule(job, 'both', {
  cron: '* * * * *',
  everyMs: 1_000,
  payload: { mode: 'daily' }
})

// @ts-expect-error A schedule must choose exactly one cadence strategy.
JobSchedules.schedule(job, 'neither', { payload: { mode: 'daily' } })
