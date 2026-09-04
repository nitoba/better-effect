// oxlint-disable typescript/await-thenable -- Bun's test declarations are Promise-compatible at runtime.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobStore, type AnyJobStoreToken, type JobStore as JobStoreType } from 'better-effect-mq'
import { jobStoreContract, type JobStoreContractSynchronization } from 'better-effect-mq/testing'
import { MongoClient } from 'mongodb'
import { MongoJobStore } from '../../src/index'

const uri = process.env.MONGODB_URL
const databaseName = `better_effect_mq_mongodb_contract_${process.pid}`
const namespace = 'contract'
const integration = uri === undefined ? test.skip : test
let client: MongoClient | undefined

const db = () => {
  if (client === undefined) throw new Error('MongoDB test client was not initialized')
  return client.db(databaseName)
}

const synchronizeStore = (
  store: JobStoreType.Contract,
  synchronization: JobStoreContractSynchronization
): void => {
  const originalAwaitWake = store.awaitWake.bind(store)
  Object.defineProperty(store, 'awaitWake', {
    configurable: true,
    enumerable: false,
    value: (request: JobStoreType.AwaitWakeRequest) => {
      const waiting = originalAwaitWake(request)
      synchronization.ready()
      return Promise.resolve(waiting).then((result) => {
        synchronization.observed()
        return result
      })
    },
    writable: true
  })
}

const makeLayer = <const Token extends AnyJobStoreToken>(token: Token) =>
  MongoJobStore.layerFor(token, {
    db: db(),
    namespace,
    validateLayout: false,
    notifications: 'auto'
  })

const suite = jobStoreContract({
  capabilities: {
    queueFilteredNotifications: true,
    nativeBatchEnqueue: true,
    nativeBatchClaim: true,
    metadataIndex: 'indexed',
    transactionalEnqueue: true,
    durableChangeFeed: false,
    globalConcurrency: false,
    rateLimiting: false
  },
  makeRuntime: async (context) => {
    const runtime = await Runtime.make(
      MongoJobStore.layer({ db: db(), namespace, validateLayout: false, notifications: 'auto' })
    )
    await runtime.run(async () => {
      synchronizeStore(await ServiceRuntime.resolve(JobStore), context.synchronization)
    })
    return runtime
  },
  makeMultiStoreRuntime: async (context) => {
    const runtime = await Runtime.make(
      Layer.merge(
        MongoJobStore.layerFor(context.tokens.default, {
          db: db(),
          namespace,
          validateLayout: false,
          notifications: 'auto'
        }),
        makeLayer(context.tokens.first),
        makeLayer(context.tokens.second)
      )
    )
    await runtime.run(async () => {
      synchronizeStore(
        await ServiceRuntime.resolve(context.tokens.default),
        context.synchronization
      )
      synchronizeStore(await ServiceRuntime.resolve(context.tokens.first), context.synchronization)
      synchronizeStore(await ServiceRuntime.resolve(context.tokens.second), context.synchronization)
    })
    return runtime
  },
  reset: async () => {
    await Promise.all([
      db().collection('better_effect_mq_attempts').deleteMany({}),
      db().collection('better_effect_mq_jobs').deleteMany({}),
      db().collection('better_effect_mq_queues').deleteMany({}),
      db().collection('better_effect_mq_counters').deleteMany({})
    ])
  }
})

describe('MongoDB JobStore conformance on a replica set', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    client = new MongoClient(uri)
    await client.connect()
    await MongoJobStore.migrate({ db: db() })
  })
  afterAll(async () => {
    if (client === undefined) return
    await db().dropDatabase()
    await client.close()
  })

  for (const scenario of suite) {
    integration(scenario.name, async () => {
      await scenario.run()
    })
  }

  integration('executes every enabled protocol-v1 contract scenario', () => {
    const report = suite.report()
    expect(report.failed).toEqual([])
    expect(report.executed).toHaveLength(suite.length)
    expect(report.passed).toHaveLength(suite.length)
    expect(report.capabilitiesNotTested).toEqual([])
  })
})
