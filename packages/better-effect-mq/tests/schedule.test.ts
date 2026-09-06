// oxlint-disable anti-slop/no-unknown-returns -- invalid-boundary helper intentionally accepts arbitrary callbacks.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- malformed values model runtime input.

import { expect, test } from 'bun:test'
import { Result } from 'better-result'

import { Codec, JobDefinitionError, Queue, Retry } from '../src'
import {
  JobSchedules,
  encodeScheduleKey,
  encodeSchedulePayload,
  firstEveryMsOccurrence,
  makeScheduleOccurrenceId,
  nextCronOccurrence,
  nextEveryMsOccurrence,
  nextScheduleOccurrence
} from '../src/schedule'

const expectDefinitionError = (operation: () => unknown): void => {
  try {
    operation()
    throw new Error('expected operation to throw')
  } catch (cause) {
    expect(JobDefinitionError.is(cause)).toBe(true)
  }
}

const invoiceJob = Queue.define('billing').job('generate-invoice', {
  version: 3,
  payload: Codec.json<{ readonly mode: 'daily' | 'monthly' }>()
})

test('JobSchedules creates immutable grouped definitions with normalized defaults', () => {
  const draft = JobSchedules.schedule(invoiceJob, 'monthly/invoices', {
    cron: '0 0 1 * *',
    timeZone: 'America/Fortaleza',
    payload: { mode: 'monthly' },
    metadata: { source: 'billing' },
    priority: 4,
    attempts: 3,
    timeoutMs: 30_000,
    misfire: { strategy: 'run-once' },
    overlap: 'skip'
  })
  const definitions = JobSchedules.define({ group: 'billing-service', schedules: [draft] })
  const [schedule] = definitions.schedules

  expect(schedule).toBeDefined()
  expect(schedule?.group).toBe('billing-service')
  expect(schedule?.key).toBe('monthly/invoices')
  expect(schedule?.job.identity).toEqual({ queue: 'billing', name: 'generate-invoice', version: 3 })
  expect(schedule?.strategy).toBe('cron')
  expect(schedule?.cron).toBe('0 0 1 * *')
  expect(schedule?.everyMs).toBeUndefined()
  expect(schedule?.timeZone).toBe('America/Fortaleza')
  expect(schedule?.defaults).toEqual({
    attempts: 3,
    backoff: undefined,
    timeoutMs: 30_000,
    priority: 4
  })
  expect(schedule?.metadata).toEqual({ source: 'billing' })
  expect(schedule?.misfire).toEqual({ strategy: 'run-once' })
  expect(schedule?.overlap).toBe('skip')
  expect(schedule?.identity).toEqual({
    group: 'billing-service',
    key: 'monthly/invoices',
    job: { queue: 'billing', name: 'generate-invoice', version: 3 }
  })
  expect(schedule?.payload).toEqual({ mode: 'monthly' })
  expect(Object.isFrozen(draft)).toBe(true)
  expect(Object.isFrozen(schedule)).toBe(true)
  expect(Object.isFrozen(definitions)).toBe(true)
  expect(Object.isFrozen(definitions.schedules)).toBe(true)
  expect(Object.isFrozen(schedule?.defaults)).toBe(true)
  expect(Object.isFrozen(schedule?.metadata)).toBe(true)
  expect(Object.isFrozen(schedule?.identity)).toBe(true)
})

test('schedule payloads use the JobDefinition codec without persistence', async () => {
  const schedule = JobSchedules.define({
    group: 'billing-service',
    schedules: [
      JobSchedules.schedule(invoiceJob, 'daily', {
        everyMs: 60_000,
        payload: { mode: 'daily' }
      })
    ]
  }).schedules[0]!

  const encoded = await Promise.resolve(encodeSchedulePayload(schedule))

  expect(Result.isOk(encoded)).toBe(true)
  if (Result.isOk(encoded)) {
    expect(encoded.value).toEqual({ mode: 'daily' })
  }
})

test('schedule definitions reject invalid identity, strategy, timezone and fields', () => {
  expectDefinitionError(() => JobSchedules.define({ group: '' as string, schedules: [] }))
  expectDefinitionError(() =>
    JobSchedules.schedule(invoiceJob, '' as string, {
      everyMs: 1_000,
      payload: { mode: 'daily' }
    })
  )
  expectDefinitionError(() =>
    JobSchedules.schedule(invoiceJob, 'invalid', {
      everyMs: 1_000,
      cron: '* * * * *',
      payload: { mode: 'daily' }
    } as never)
  )
  expectDefinitionError(() =>
    JobSchedules.schedule(invoiceJob, 'invalid', { payload: { mode: 'daily' } } as never)
  )
  expectDefinitionError(() =>
    JobSchedules.schedule(invoiceJob, 'invalid', {
      everyMs: 0,
      payload: { mode: 'daily' }
    })
  )
  expectDefinitionError(() =>
    JobSchedules.schedule(invoiceJob, 'invalid', {
      cron: '* * * * *',
      timeZone: 'Not/A-Timezone',
      payload: { mode: 'daily' }
    })
  )
  expectDefinitionError(() =>
    JobSchedules.schedule(invoiceJob, 'invalid', {
      cron: '* * * * * *',
      payload: { mode: 'daily' }
    })
  )
  expectDefinitionError(() =>
    JobSchedules.schedule(invoiceJob, 'invalid', {
      everyMs: 1_000,
      payload: { mode: 'daily' },
      misfire: { strategy: 'catch-up', maxOccurrences: 0 }
    })
  )
})

test('JobSchedules.define rejects duplicate keys in one group', () => {
  const first = JobSchedules.schedule(invoiceJob, 'same', {
    everyMs: 1_000,
    payload: { mode: 'daily' }
  })
  const second = JobSchedules.schedule(invoiceJob, 'same', {
    everyMs: 2_000,
    payload: { mode: 'daily' }
  })

  expectDefinitionError(() =>
    JobSchedules.define({ group: 'billing-service', schedules: [first, second] })
  )
})

test('cron calculates five-field occurrences in UTC by default', () => {
  const after = Date.UTC(2024, 0, 2, 12, 0)

  expect(nextCronOccurrence('0 0 1 * *', after)).toBe(Date.UTC(2024, 1, 1, 0, 0))
  expect(nextCronOccurrence('*/15 9-10 1,15 * 1-5', Date.UTC(2024, 5, 1, 8, 59))).toBe(
    Date.UTC(2024, 5, 1, 9, 0)
  )
  expect(nextCronOccurrence('0 0 29 2 *', Date.UTC(2023, 0, 1))).toBe(Date.UTC(2024, 1, 29, 0, 0))
  expect(nextCronOccurrence('0 0 31 * *', Date.UTC(2024, 1, 1))).toBe(Date.UTC(2024, 2, 31, 0, 0))
})

test('schedule defaults accept the existing retry policy and defaults shape', () => {
  const schedule = JobSchedules.define({
    group: 'billing-service',
    schedules: [
      JobSchedules.schedule(invoiceJob, 'retrying', {
        everyMs: 60_000,
        payload: { mode: 'daily' },
        defaults: {
          attempts: 4,
          backoff: Retry.exponential({ initialDelayMs: 100, maxAttempts: 4 }),
          timeoutMs: 5_000,
          priority: -2
        }
      })
    ]
  }).schedules[0]!

  expect(schedule.defaults).toEqual({
    attempts: 4,
    backoff: { type: 'exponential', delayMs: 100 },
    timeoutMs: 5_000,
    priority: -2
  })
})

test('cron uses deterministic DST policy: skip gaps and choose the earlier fold', () => {
  const springAfter = Date.UTC(2024, 2, 9, 8, 0)
  const fallAfter = Date.UTC(2024, 10, 2, 8, 0)
  const firstFallOccurrence = nextCronOccurrence('30 1 * * *', fallAfter, 'America/New_York')

  expect(nextCronOccurrence('30 2 * * *', springAfter, 'America/New_York')).toBe(
    Date.UTC(2024, 2, 11, 6, 30)
  )
  expect(firstFallOccurrence).toBe(Date.UTC(2024, 10, 3, 5, 30))
  expect(nextCronOccurrence('30 1 * * *', firstFallOccurrence, 'America/New_York')).toBe(
    Date.UTC(2024, 10, 4, 6, 30)
  )
})

test('everyMs uses a first slot and retains its original grade', () => {
  const first = firstEveryMsOccurrence(15_000, 1_000)

  expect(first).toBe(16_000)
  expect(nextEveryMsOccurrence(15_000, 1_000, first)).toBe(first)
  expect(nextEveryMsOccurrence(15_000, first, first)).toBe(31_000)
  expect(nextEveryMsOccurrence(15_000, 35_000, first)).toBe(46_000)
})

test('schedule occurrence IDs encode keys without collisions', () => {
  expect(encodeScheduleKey('billing/invoices')).toBe('billing%2Finvoices')
  expect(makeScheduleOccurrenceId('billing/invoices', 1_700_000_000_000)).toBe(
    'sched/billing%2Finvoices/1700000000000'
  )

  const schedule = JobSchedules.define({
    group: 'billing-service',
    schedules: [
      JobSchedules.schedule(invoiceJob, 'daily', {
        everyMs: 60_000,
        payload: { mode: 'daily' }
      })
    ]
  }).schedules[0]!

  expect(nextScheduleOccurrence(schedule, 1_000)).toBe(61_000)
})
