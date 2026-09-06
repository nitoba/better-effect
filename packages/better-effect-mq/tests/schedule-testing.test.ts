// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- malformed adapter values are intentional boundary fixtures.

import { expect, test } from 'bun:test'

import { ClockTest } from 'better-effect/standard-services'

import { JobScheduleStore, JobStore, MemoryJobScheduleStore, MemoryJobStore } from '../src'
import {
  JobScheduleStoreConformanceError,
  jobScheduleStoreContract,
  type JobScheduleStoreContractScenario
} from '../src/testing'

const makeSuite = () =>
  jobScheduleStoreContract({
    clock: () => new ClockTest(1_700_000_000_000),
    makeStore: () => MemoryJobStore.make(),
    makeScheduleStore: ({ jobStore }) => MemoryJobScheduleStore.make({ jobStore })
  })

const byId = (
  suite: readonly JobScheduleStoreContractScenario[],
  id: string
): JobScheduleStoreContractScenario => {
  const scenario = suite.find((item) => item.id === id)
  if (scenario === undefined) throw new Error(`missing schedule contract scenario ${id}`)
  return scenario
}

test('JobScheduleStore contract publishes stable scenario metadata', () => {
  const metadata = makeSuite().map(({ id, category, name }) => `${id}|${category}|${name}`)

  expect(metadata).toEqual([
    'validation-cadence-and-timezone|validation|invalid cadence and timezone are rejected at the store boundary',
    'upsert-idempotent-cadence|upsert|unchanged upserts preserve position and cadence changes advance revision',
    'cas-concurrent-occurrence|atomicity|concurrent ticks allow one winner and one stale result',
    'response-loss-retry|atomicity|retrying a committed tick does not refire its deterministic occurrence',
    'deterministic-occurrence-id|identity|occurrence IDs are stable, bounded, and collision-free for encoded keys',
    'misfire-skip|misfire|skip misfires advance without creating jobs and report skipped slots',
    'misfire-run-once|misfire|run-once misfires create exactly the overdue occurrence',
    'misfire-catch-up-bounded|misfire|catch-up progresses in bounded batches while remaining overdue',
    'overlap-allow|overlap|allow overlap enqueues every decided occurrence',
    'overlap-skip|overlap|skip overlap suppresses a new occurrence while the previous job is active',
    'pause-resume|lifecycle|paused schedules are not due and resume without losing their position',
    'named-store-isolation|namespace|default and named schedule stores keep records and jobs isolated',
    'reconcile-warn-group-grace|reconciliation|reconcile warns, removes by group, and honors a Clock-driven grace window',
    'timezone-dst|cron|cron uses deterministic timezone, DST, month, leap-year, and step semantics',
    'invalid-payload-no-partial|validation|invalid payloads fail before a schedule record is partially persisted',
    'atomic-tick-enqueue-wake|atomicity|a tick makes enqueue and queue wake visible as one operation'
  ])
})

test('MemoryJobScheduleStore passes the complete runner-agnostic contract', async () => {
  const suite = makeSuite()

  for (const scenario of suite) await scenario.run()

  expect(suite.report().executed).toHaveLength(suite.length)
  expect(suite.report().passed).toEqual(suite.map((scenario) => scenario.id))
  expect(suite.report().failed).toEqual([])
  expect(suite.report().descriptor).toEqual({
    extension: 'better-effect-mq/schedules',
    extensionVersion: 1,
    jobStoreProtocolVersion: 1
  })
})

test('JobScheduleStore contract supports an explicitly named schedule token', async () => {
  const Named = JobStore.named('contract-named-schedules')
  const NamedSchedules = JobScheduleStore.for(Named)
  const suite = jobScheduleStoreContract({
    token: NamedSchedules,
    clock: () => new ClockTest(1_700_000_000_000),
    makeStore: () => MemoryJobStore.make(),
    makeScheduleStore: ({ jobStore }) => MemoryJobScheduleStore.make({ jobStore })
  })

  await byId(suite, 'upsert-idempotent-cadence').run()

  expect(suite.report().passed).toEqual(['upsert-idempotent-cadence'])
})

test('JobScheduleStore contract resets after setup and reports primary failures', async () => {
  let resetCount = 0
  const setupFailure = new Error('setup failed')
  const suite = jobScheduleStoreContract({
    setup: () => {
      throw setupFailure
    },
    reset: async () => {
      resetCount += 1
    },
    makeStore: () => MemoryJobStore.make(),
    makeScheduleStore: ({ jobStore }) => MemoryJobScheduleStore.make({ jobStore })
  })

  let cause: unknown
  try {
    await byId(suite, 'upsert-idempotent-cadence').run()
  } catch (error) {
    cause = error
  }

  expect(cause).toBe(setupFailure)
  expect(resetCount).toBe(1)
  expect(suite.report().failed).toEqual(['upsert-idempotent-cadence'])
})

test('JobScheduleStore contract wraps broken adapter results with scenario diagnostics', async () => {
  const suite = jobScheduleStoreContract({
    makeStore: () => MemoryJobStore.make(),
    makeScheduleStore: () =>
      ({
        descriptor: {
          extension: 'wrong-extension',
          extensionVersion: 1,
          jobStoreProtocolVersion: 1
        }
      }) as never
  })

  let cause: unknown
  try {
    await byId(suite, 'upsert-idempotent-cadence').run()
  } catch (error) {
    cause = error
  }

  expect(cause).toBeInstanceOf(JobScheduleStoreConformanceError)
  expect((cause as JobScheduleStoreConformanceError).invariant).toBe('descriptor compatibility')
})
