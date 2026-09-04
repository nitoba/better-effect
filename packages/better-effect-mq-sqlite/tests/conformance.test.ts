import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobStore, type JobStore as JobStoreType } from 'better-effect-mq'
import { jobStoreContract, type JobStoreContractSynchronization } from 'better-effect-mq/testing'
import { SqliteJobStore } from '../src/index'

const databases: Database[] = []

const synchronize = (
  store: JobStoreType.Contract,
  synchronization: JobStoreContractSynchronization
): void => {
  const original = store.awaitWake.bind(store)
  Object.defineProperty(store, 'awaitWake', {
    value: (request: JobStoreType.AwaitWakeRequest) => {
      const result = original(request)
      synchronization.ready()
      return Promise.resolve(result).then((value) => {
        synchronization.observed()
        return value
      })
    }
  })
}

const runtime = async (context: { readonly synchronization: JobStoreContractSynchronization }) => {
  const database = new Database(':memory:')
  databases.push(database)
  SqliteJobStore.migrate({ database })
  const value = await Runtime.make(SqliteJobStore.layer({ database, configurePragmas: true }))
  await value.run(async () =>
    synchronize(await ServiceRuntime.resolve(JobStore), context.synchronization)
  )
  return value
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const suite = jobStoreContract({
  capabilities: {
    queueFilteredNotifications: true,
    nativeBatchEnqueue: true,
    nativeBatchClaim: true,
    metadataIndex: 'residual',
    transactionalEnqueue: false,
    durableChangeFeed: false,
    globalConcurrency: false,
    rateLimiting: false
  },
  makeRuntime: runtime,
  makeMultiStoreRuntime: async (context) => {
    const database = new Database(':memory:')
    databases.push(database)
    SqliteJobStore.migrate({ database })
    const value = await Runtime.make(
      Layer.merge(
        SqliteJobStore.layer({ database, configurePragmas: true }),
        SqliteJobStore.layerFor(JobStore.named('contract-store-a'), {
          database,
          configurePragmas: true
        }),
        SqliteJobStore.layerFor(JobStore.named('contract-store-b'), {
          database,
          configurePragmas: true
        })
      )
    )
    await value.run(async () =>
      synchronize(await ServiceRuntime.resolve(JobStore), context.synchronization)
    )
    return value
  }
})

describe('SQLite JobStore protocol v1 conformance', () => {
  for (const scenario of suite) test(scenario.name, scenario.run)
  test('executes each enabled scenario', () => {
    const report = suite.report()
    expect(report.failed).toEqual([])
    expect(report.executed).toHaveLength(suite.length)
  })
})
