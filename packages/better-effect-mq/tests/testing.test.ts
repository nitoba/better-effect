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

const makeSuite = (fault?: MemoryStoreFault) =>
  jobStoreContract({
    capabilities,
    makeRuntime: async () =>
      makeMemoryRuntime(
        makeMemoryJobStore(fault === undefined ? { capabilities } : { capabilities, fault })
      )
  })

const byId = (suite: readonly JobStoreContractScenario[], id: string): JobStoreContractScenario => {
  const scenario = suite.find((item) => item.id === id)
  if (scenario === undefined) throw new Error(`missing contract scenario ${id}`)
  return scenario
}

for (const scenario of makeSuite()) {
  test(`JobStore contract: ${scenario.id}`, scenario.run)
}

test('JobStore contract reports capability coverage and skips', () => {
  const suite = jobStoreContract({
    makeRuntime: async () => makeMemoryRuntime(makeMemoryJobStore())
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
      return makeMemoryRuntime(makeMemoryJobStore())
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
      return makeMemoryRuntime(makeMemoryJobStore())
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
      const runtime = await makeMemoryRuntime(makeMemoryJobStore({ fault: 'wrong-ordering' }))
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
      const runtime = await makeMemoryRuntime(makeMemoryJobStore())
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

test('JobStore contract detects a lost wake with a bounded harness watchdog', async () => {
  const scenario = byId(makeSuite('lost-wake'), 'wake-token-change')
  const outcome = await Promise.race([
    scenario.run().then(
      () => 'passed' as const,
      () => 'failed' as const
    ),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50))
  ])

  expect(outcome).toBe('timeout')
})
