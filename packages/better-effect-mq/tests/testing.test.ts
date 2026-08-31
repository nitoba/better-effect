import { expect, test } from 'bun:test'

import { JobStore } from '../src'
import {
  JobStoreConformanceError,
  jobStoreContract,
  type JobStoreContractScenario
} from '../src/testing'

import {
  makeMemoryJobStore,
  makeMemoryRuntime,
  type MemoryStoreFault
} from './helpers/memory-job-store'

const capabilities = {
  notifications: true,
  batchClaim: true
} as const

const expectedScenarioMetadata = [
  'enqueue-immediate-waiting|enqueue|immediate enqueue enters waiting',
  'enqueue-future-delayed|enqueue|future enqueue enters delayed',
  'enqueue-explicit-id-duplicate|enqueue|duplicate explicit IDs are idempotent no-ops',
  'enqueue-idempotency-concurrent|enqueue|concurrent idempotency keys create one job',
  'enqueue-generated-id-unique|enqueue|generated IDs do not collide with explicit IDs',
  'enqueue-many-order|enqueue|enqueueMany preserves input order and result alignment',
  'enqueue-many-independent-replay|enqueue|enqueueMany keeps independently replayable duplicate units',
  'enqueue-round-trip|enqueue|metadata and identity version round-trip through getJob',
  'claim-priority-order|claim|claim orders higher priority first',
  'claim-fifo-tiebreak|claim|claim preserves FIFO within equal priority and runAt',
  'claim-queue-isolation|claim|claim isolates queues',
  'claim-accepted-identity-filter|claim|claim filters by accepted job identity',
  'claim-respects-limit|claim|claim never exceeds its limit',
  'claim-concurrent-exclusive|claim|concurrent claims do not share a current lease',
  'claim-promotes-due-delayed|claim|claim promotes delayed work when its runAt is due',
  'claim-empty-wake-token|claim|empty claim returns coherent nextRunAt and wakeToken',
  'claim-paused-queue|claim|paused queues do not deliver work',
  'lease-claim-fields|lease|claim creates owner, token, expiry, and delivery fields',
  'lease-heartbeat-current-token|lease|heartbeat renews only the current lease token',
  'lease-fencing-rejects-old-token|lease|old settlement tokens fail without mutation',
  'lease-release-no-attempt|lease|current release returns waiting without consuming a handler attempt',
  'lease-release-old-token|lease|an old release token fails after redelivery',
  'lease-recover-expired|lease|expired leases are recovered and recorded as stalled',
  'lease-does-not-recover-valid|lease|valid leases are not recovered',
  'lease-stall-policy|lease|repeated stalls eventually terminalize according to maxStalledCount',
  'lease-cancellation-request|lease|active cancellation requests retain the lease until the next exit',
  'settle-complete-ledger|settlement|complete persists result and one completed attempt',
  'settle-retry-ledger|settlement|retry persists failure and a future runAt',
  'settle-fail-terminal|settlement|fail is terminal and records a failed attempt',
  'settle-cancelled-terminal|settlement|cancelled settlement is terminal and consumes one attempt',
  'settle-duplicate-no-reapply|settlement|duplicate settlement does not apply a second transition',
  'settle-attempt-once|settlement|settlement increments attemptsMade exactly once',
  'redrive-preserves-ledger|settlement|administrative redrive preserves prior delivery and attempt history',
  'release-stalled-ledger|settlement|release and stalled recovery do not fake handler attempts',
  'admin-cancel-waiting-delayed|admin|administrative cancel handles waiting and delayed jobs',
  'admin-cancel-terminal-rejected|admin|administrative cancel rejects terminal jobs',
  'admin-promote-delayed|admin|promote makes delayed work waiting without claiming it',
  'admin-promote-state-rejected|admin|promote rejects non-delayed jobs',
  'admin-redrive-failed-only|admin|redrive is available only for terminal retryable states',
  'admin-pause-resume|admin|pause and resume are durable store state',
  'admin-remove-active-rejected|admin|remove refuses active jobs',
  'admin-counts-coherent|admin|counts remain coherent across state transitions',
  'list-filters|listing|list supports the portable queue, name, and state filters',
  'list-empty|listing|empty list states return no jobs and no cursor',
  'list-keyset-pagination|listing|keyset pagination has no overlap or loss',
  'list-timestamp-tie|listing|equal timestamps use a deterministic insertion tiebreaker',
  'list-get-fields|listing|getJob and list expose the same public record fields',
  'list-cursor-options|listing|cursor reuse with incompatible filters fails explicitly',
  'list-support-matrix|listing|unsupported list filters fail instead of triggering a hidden scan',
  'validation-rejects-invalid-duration|validation|invalid durations fail at the public request boundary',
  'clock-controlled-delay|time|clock advancement reproduces delayed claim behavior',
  'wake-abort|wake|awaitWake respects AbortSignal and returns its typed error',
  'wake-token-change|wake|a token change wakes a notification-capable store',
  'wake-enqueue-notifies-waiter|wake|enqueue wakes a waiter registered on the same queue',
  'wake-queue-filter|wake|wake notifications do not cross queue boundaries',
  'wake-occurs-before-wait|wake|a wake between empty claim and wait is observed by its token',
  'batch-claim-order|claim|declared batch claiming returns one ordered batch'
] as const

const makeSuite = (fault?: MemoryStoreFault) =>
  jobStoreContract({
    capabilities,
    makeRuntime: async () =>
      makeMemoryRuntime(
        makeMemoryJobStore(fault === undefined ? { capabilities } : { capabilities, fault }),
        JobStore
      )
  })

const byId = (suite: readonly JobStoreContractScenario[], id: string): JobStoreContractScenario => {
  const scenario = suite.find((item) => item.id === id)
  if (scenario === undefined) throw new Error(`missing contract scenario ${id}`)
  return scenario
}

test('JobStore contract pins scenario metadata', () => {
  const metadata = makeSuite().map(({ id, category, name }) => `${id}|${category}|${name}`)
  expect(metadata).toEqual([...expectedScenarioMetadata])
})

for (const scenario of makeSuite()) {
  test(`JobStore contract: ${scenario.id}`, scenario.run)
}

test('JobStore contract reports capability coverage and skips', () => {
  const suite = jobStoreContract({
    makeRuntime: async () => makeMemoryRuntime(makeMemoryJobStore(), JobStore)
  })
  const report = suite.report()

  expect(report.skipped.some((item) => item.id === 'wake-token-change')).toBe(true)
  expect(report.skipped.some((item) => item.id === 'batch-claim-order')).toBe(true)
  expect(report.capabilitiesNotTested).toEqual([
    'notifications',
    'batchClaim',
    'transactionalEnqueue',
    'changeFeed'
  ])
})

test('JobStore contract honors a named JobStore token', async () => {
  const token = JobStore.named('contract-named')
  const suite = jobStoreContract({
    token,
    makeRuntime: async () => makeMemoryRuntime(makeMemoryJobStore(), token)
  })

  await byId(suite, 'enqueue-immediate-waiting').run()
  expect(suite.report().passed).toEqual(['enqueue-immediate-waiting'])
})

test('JobStore contract isolates setup, runtimes, and reset per scenario', async () => {
  let setups = 0
  let resets = 0
  let runtimes = 0
  const suite = jobStoreContract({
    setup: async () => {
      setups += 1
    },
    reset: async () => {
      resets += 1
    },
    makeRuntime: async () => {
      runtimes += 1
      return makeMemoryRuntime(makeMemoryJobStore(), JobStore)
    }
  })

  await byId(suite, 'enqueue-immediate-waiting').run()
  await byId(suite, 'list-empty').run()

  expect(setups).toBe(2)
  expect(resets).toBe(2)
  expect(runtimes).toBe(2)
})

const expectConformanceFailure = async (scenario: JobStoreContractScenario): Promise<void> => {
  let cause: unknown
  try {
    await scenario.run()
  } catch (error) {
    cause = error
  }
  expect(cause).toBeInstanceOf(JobStoreConformanceError)
}

test('JobStore contract runs reset after setup failure', async () => {
  const setupFailure = new Error('setup failed')
  let runtimeCreated = 0
  let resetCount = 0
  const suite = jobStoreContract({
    setup: () => {
      throw setupFailure
    },
    reset: async () => {
      resetCount += 1
    },
    makeRuntime: async () => {
      runtimeCreated += 1
      return makeMemoryRuntime(makeMemoryJobStore(), JobStore)
    }
  })

  let cause: unknown
  try {
    await byId(suite, 'list-empty').run()
  } catch (error) {
    cause = error
  }

  expect(cause).toBe(setupFailure)
  expect(runtimeCreated).toBe(0)
  expect(resetCount).toBe(1)
  expect(suite.report().failed).toEqual(['list-empty'])
})

test('JobStore contract preserves primary failures over cleanup failures', async () => {
  const suite = jobStoreContract({
    makeRuntime: async () => {
      const runtime = await makeMemoryRuntime(
        makeMemoryJobStore({ fault: 'wrong-ordering' }),
        JobStore
      )
      return {
        run: runtime.run,
        dispose: async () => {
          await runtime.dispose()
          throw new Error('cleanup failed')
        }
      }
    }
  })

  let cause: unknown
  try {
    await byId(suite, 'claim-priority-order').run()
  } catch (error) {
    cause = error
  }

  expect(cause).toBeInstanceOf(JobStoreConformanceError)
  // SAFETY: the assertion immediately above establishes the caught error type.
  expect((cause as JobStoreConformanceError).invariant).toBe('claim ordering')
  expect(suite.report().failed).toEqual(['claim-priority-order'])
})

test('JobStore contract disposes extension clients in the same scenario', async () => {
  let created = 0
  let disposed = 0
  const suite = jobStoreContract({
    makeRuntime: async () => {
      created += 1
      const runtime = await makeMemoryRuntime(makeMemoryJobStore(), JobStore)
      return {
        run: runtime.run,
        dispose: async () => {
          disposed += 1
          await runtime.dispose()
        }
      }
    },
    extensions: [
      {
        id: 'extension-opens-second-client',
        name: 'extension opens a second client',
        category: 'extension',
        run: async (context) => {
          await context.checkpoint('before-second-client')
          await context.openClient()
        }
      }
    ]
  })

  await byId(suite, 'extension-opens-second-client').run()

  expect(created).toBe(2)
  expect(disposed).toBe(2)
})

test('JobStore contract detects a missing fencing check', async () => {
  await expectConformanceFailure(byId(makeSuite('no-fencing'), 'lease-fencing-rejects-old-token'))
})

test('JobStore contract detects incorrect claim ordering', async () => {
  await expectConformanceFailure(byId(makeSuite('wrong-ordering'), 'claim-priority-order'))
})

test('JobStore contract detects duplicate claims', async () => {
  await expectConformanceFailure(byId(makeSuite('duplicate-claim'), 'claim-concurrent-exclusive'))
})

test('JobStore contract detects broken keyset pagination', async () => {
  await expectConformanceFailure(byId(makeSuite('broken-pagination'), 'list-keyset-pagination'))
})

test('JobStore contract detects a lost wake without a timer watchdog', async () => {
  await expectConformanceFailure(byId(makeSuite('lost-wake'), 'wake-token-change'))
})
