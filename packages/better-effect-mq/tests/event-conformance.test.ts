// Memory has no namespace option; each scenario receives a fresh pair of stores,
// which is the in-process equivalent of a namespace reset.

import { expect, test } from 'bun:test'
import { Effect, Layer, Runtime } from 'better-effect'
import { Clock, ClockTest } from 'better-effect/standard-services'
import { Result } from 'better-result'

import {
  Codec,
  JobEventStore,
  JobEventStoreFailure,
  JobStore,
  MemoryJobEventStore,
  MemoryJobStore,
  Queue,
  QueueName,
  WorkerId,
  type JobEventStoreContract,
  type JobEventStoreOperation,
  type JobId
} from '../src'
import { jobEventStoreContract, type JobEventStoreContractFactoryOptions } from '../src/testing'

const queue = Queue.define('memory-event-contract')
const AwaitResultJob = queue.job('await-result', {
  version: 1,
  payload: Codec.json<{ readonly value: string }>(),
  result: Codec.string
})

const contractClock = (() => {
  let current = 0
  return {
    now: () => current,
    advance(milliseconds: number) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new RangeError('contract clock advances must be non-negative safe integers')
      }
      current += milliseconds
    },
    reset() {
      current = 0
    }
  }
})()

type MemoryStoreInstances = { readonly event: object[]; readonly job: object[] }

const memoryStores: MemoryStoreInstances = { event: [], job: [] }
const setupScenarios: string[] = []
const resetScenarios: string[] = []

const makeEventStore = (options?: JobEventStoreContractFactoryOptions): JobEventStoreContract => {
  const store =
    options?.retention === undefined
      ? MemoryJobEventStore.make({ clock: contractClock })
      : MemoryJobEventStore.make({ clock: contractClock, retention: options.retention })
  memoryStores.event.push(store)
  return store
}

const makeJobStore = (eventStore: JobEventStoreContract) => {
  const store = MemoryJobStore.make({ clock: contractClock, eventStore })
  memoryStores.job.push(store)
  return store
}

const makeJobStoreWithoutEventStore = () => {
  const store = MemoryJobStore.make({ clock: contractClock })
  memoryStores.job.push(store)
  return store
}

const makeRuntime = async (
  jobStore: JobStore.Contract,
  eventStore: JobEventStore.Contract,
  clock: ClockTest
) =>
  Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(jobStore)),
      Layer.succeed(JobEventStore, JobEventStore.of(eventStore)),
      Layer.succeed(Clock, clock)
    )
  )

const waitUntilPolling = async (clock: ClockTest): Promise<void> => {
  for (let attempt = 0; attempt < 100 && clock.pendingSleeps === 0; attempt += 1) {
    await Promise.resolve()
  }
  if (clock.pendingSleeps === 0) throw new Error('awaitResult did not reach its wait boundary')
}

const completeAwaitedJob = async (
  jobStore: JobStore.Contract,
  jobId: JobId,
  now: number,
  workerId: string,
  result: string
): Promise<void> => {
  const claimed = await jobStore.claim({
    queue: QueueName.make(queue.queue).unwrap(),
    accepted: [AwaitResultJob.identity],
    limit: 1,
    workerId: WorkerId.make(workerId).unwrap(),
    leaseDurationMs: 100,
    now
  })
  if (Result.isError(claimed)) throw claimed.error
  const active = claimed.value.jobs[0]
  if (active === undefined) throw new Error('awaited Job was not claimed')

  const settled = await jobStore.settle({
    jobId,
    leaseToken: active.leaseToken,
    outcome: { type: 'complete', result },
    now
  })
  if (Result.isError(settled)) throw settled.error
}

const awaitResultExtension = {
  id: 'event-await-result-race',
  name: 'event-driven awaitResult closes the cursor/read race',
  category: 'await-result',
  run: async (context: {
    readonly eventStore: JobEventStoreContract
    readonly jobStore: JobStore.Contract
    readonly clock: { now(): number }
  }) => {
    const clock = new ClockTest(context.clock.now())
    const runtime = await makeRuntime(context.jobStore, context.eventStore, clock)
    try {
      const enqueued = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(
            yield* AwaitResultJob.enqueue(
              { value: 'event-driven' },
              { jobId: 'event-await-result-race' }
            )
          )
        })
      )
      if (Result.isError(enqueued)) throw enqueued.error

      const pending = runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(
            yield* AwaitResultJob.awaitResult(enqueued.value, {
              strategy: 'events',
              eventStore: JobEventStore,
              pollFallbackMs: 5_000
            })
          )
        })
      )
      await waitUntilPolling(clock)
      await completeAwaitedJob(
        context.jobStore,
        enqueued.value,
        context.clock.now(),
        'event-await-result-worker',
        'event-driven-result'
      )

      const result = await pending
      if (Result.isError(result)) throw result.error
      if (result.value !== 'event-driven-result') {
        throw new Error(`unexpected event-driven result ${String(result.value)}`)
      }
    } finally {
      await runtime.dispose()
    }
  }
} as const

const pollFallbackExtension = {
  id: 'event-wake-lost-poll-fallback',
  name: 'lost event wake falls back to polling',
  category: 'wake',
  run: async (context: {
    readonly eventStore: JobEventStoreContract
    readonly jobStore: JobStore.Contract
    readonly clock: { now(): number }
  }) => {
    const brokenEventStore: JobEventStoreContract = {
      descriptor: context.eventStore.descriptor,
      tailCursor: () => context.eventStore.tailCursor(),
      activation: () => context.eventStore.activation(),
      readiness: (writer) => context.eventStore.readiness(writer),
      activate: (options) => context.eventStore.activate(options),
      read: (options) => context.eventStore.read(options),
      awaitEvents: () => {
        const failure = Result.err(
          new JobEventStoreFailure({
            operation: 'awaitEvents',
            message: 'notification unavailable'
          })
        )
        // SAFETY: this fixture intentionally erases a typed Result into the public operation facade.
        return failure as JobEventStoreOperation<void, JobEventStoreFailure>
      }
    }
    const clock = new ClockTest(context.clock.now())
    const runtime = await makeRuntime(context.jobStore, brokenEventStore, clock)
    try {
      const enqueued = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(
            yield* AwaitResultJob.enqueue(
              { value: 'poll-fallback' },
              { jobId: 'event-wake-lost-poll-fallback' }
            )
          )
        })
      )
      if (Result.isError(enqueued)) throw enqueued.error

      const pending = runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(
            yield* AwaitResultJob.awaitResult(enqueued.value, {
              strategy: 'events',
              eventStore: JobEventStore,
              pollFallbackMs: 10
            })
          )
        })
      )
      await waitUntilPolling(clock)
      await completeAwaitedJob(
        context.jobStore,
        enqueued.value,
        context.clock.now(),
        'event-wake-lost-worker',
        'poll-fallback-result'
      )
      clock.advance(10)

      const result = await pending
      if (Result.isError(result)) throw result.error
      if (result.value !== 'poll-fallback-result') {
        throw new Error(`unexpected poll fallback result ${String(result.value)}`)
      }
    } finally {
      await runtime.dispose()
    }
  }
} as const

const suite = jobEventStoreContract({
  clock: contractClock,
  capabilities: {
    retention: true,
    cursorExpiry: true,
    optionalEventStore: true
  },
  makeEventStore,
  makeJobStore,
  makeJobStoreWithoutEventStore,
  setup: (context) => {
    contractClock.reset()
    setupScenarios.push(context.id)
  },
  reset: (context) => {
    contractClock.reset()
    resetScenarios.push(context.id)
  },
  extensions: [awaitResultExtension, pollFallbackExtension]
})

test('MemoryJobEventStore executes every applicable JobEventStore contract scenario', async () => {
  for (const scenario of suite) await scenario.run()

  const report = suite.report()
  expect(report.failed).toEqual([])
  expect(report.executed).toHaveLength(suite.length)
  expect(report.passed).toHaveLength(suite.length)
  expect(report.capabilities).toEqual({
    retention: true,
    cursorExpiry: true,
    optionalEventStore: true
  })
  expect(report.skipped.map(({ id, reason }) => `${id}|${reason}`)).toEqual([
    'event-cancel-timeout-shutdown|provide an extension for the owning await/consumer lifecycle',
    'event-required-extension|provide an extension for the adapter protocol/layout handshake',
    'event-flow-transitions|provide an installed flow-store extension',
    'event-schedule-transitions|provide an installed schedule-store extension'
  ])
  expect(setupScenarios).toHaveLength(suite.length)
  expect(resetScenarios).toHaveLength(suite.length)
  expect(new Set(setupScenarios).size).toBe(suite.length)
  expect(new Set(resetScenarios).size).toBe(suite.length)
  expect(new Set(memoryStores.event).size).toBe(suite.length)
  expect(new Set(memoryStores.job).size).toBe(suite.length)
})
