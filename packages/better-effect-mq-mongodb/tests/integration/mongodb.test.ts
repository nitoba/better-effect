// oxlint-disable typescript/await-thenable -- Bun matcher declarations are synchronous while runtime matchers await.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobStore, type AnyJobStoreToken, type JobStore as JobStoreType } from 'better-effect-mq'
import { jobStoreContract, type JobStoreContractSynchronization } from 'better-effect-mq/testing'
import { MongoClient } from 'mongodb'
import { MongoJobStore, mongoCollections } from '../../src/index'

const uri = process.env.MONGODB_URL
const integration = uri === undefined ? test.skip : test
const namespace = `mongodb_contract_${process.pid}`
const configuredDatabaseName = process.env.MONGODB_DATABASE
let client: MongoClient | undefined
let databaseName: string | undefined

const configuredDatabase = () => {
  if (client === undefined || databaseName === undefined)
    throw new Error('MONGODB_URL did not initialize a replica-set database')
  return client.db(databaseName)
}
const makeLayer = <const Token extends AnyJobStoreToken>(token: Token) =>
  MongoJobStore.layerFor(token, { db: configuredDatabase(), namespace })
const synchronizeStore = (
  store: JobStoreType.Contract,
  synchronization: JobStoreContractSynchronization
): void => {
  const awaitWake = store.awaitWake.bind(store)
  Object.defineProperty(store, 'awaitWake', {
    configurable: true,
    enumerable: false,
    value: (request: JobStoreType.AwaitWakeRequest) => {
      const waiting = awaitWake(request)
      synchronization.ready()
      return Promise.resolve(waiting).then((result) => {
        synchronization.observed()
        return result
      })
    },
    writable: true
  })
}

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
    const runtime = await Runtime.make(MongoJobStore.layer({ db: configuredDatabase(), namespace }))
    await runtime.run(async () => {
      synchronizeStore(await ServiceRuntime.resolve(JobStore), context.synchronization)
    })
    return runtime
  },
  makeMultiStoreRuntime: async (context) => {
    const runtime = await Runtime.make(
      Layer.merge(
        MongoJobStore.layerFor(context.tokens.default, { db: configuredDatabase(), namespace }),
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
    const db = configuredDatabase()
    const filter = { namespace: { $regex: `^${namespace}` } }
    await db.collection('better_effect_mq_attempts').deleteMany(filter)
    await db.collection('better_effect_mq_jobs').deleteMany(filter)
    await db.collection('better_effect_mq_queues').deleteMany(filter)
    await db.collection('better_effect_mq_counters').deleteMany(filter)
  }
})

describe('MongoDB JobStore protocol v1 conformance on a replica set', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    client = new MongoClient(uri, { directConnection: true })
    await client.connect()
    databaseName = configuredDatabaseName ?? `better_effect_mq_mongodb_${process.pid}`
    await MongoJobStore.migrate({ db: configuredDatabase() })
  }, 30_000)
  afterAll(async () => {
    if (client === undefined || databaseName === undefined) return
    await client.close()
  }, 30_000)

  integration('migrates a transaction-capable replica-set layout', async () => {
    const collections = mongoCollections(configuredDatabase(), 'better_effect_mq')
    const sentinelId = `${namespace}:migration-sentinel`
    await collections.jobs.deleteOne({ _id: sentinelId })
    await collections.jobs.insertOne({
      _id: sentinelId,
      namespace,
      id: 'migration-sentinel',
      identity: 'migration-sentinel\u0000job\u00001',
      queue: 'migration',
      name: 'sentinel',
      version: 1,
      state: 'waiting',
      payload: null,
      metadataEntries: [],
      priority: 0,
      runAtMs: 0,
      orderSequence: 1,
      attemptsMax: 1,
      attemptsMade: 0,
      attemptSequence: 0,
      deliveryCount: 0,
      stalledCount: 0,
      cancelRequested: false,
      createdAtMs: 0,
      updatedAtMs: 0,
      ledgerCount: 0
    })
    await collections.migrations.updateOne(
      { _id: 'layout' },
      { $set: { protocolVersion: 1, layoutVersion: 1 } },
      { upsert: true }
    )
    await expect(MongoJobStore.migrate({ db: configuredDatabase() })).resolves.toEqual({
      version: 2,
      applied: true
    })
    await expect(collections.jobs.findOne({ _id: sentinelId })).resolves.toMatchObject({
      id: 'migration-sentinel'
    })
    await collections.jobs.deleteOne({ _id: sentinelId })
  })
  for (const scenario of suite)
    integration(scenario.name, async () => {
      await scenario.run()
    })
  integration(
    'executes claims, settlement ledger, wake, migration, and named-store coverage',
    () => {
      const report = suite.report()
      expect(report.failed).toEqual([])
      expect(report.executed).toHaveLength(suite.length)
      expect(report.passed).toHaveLength(suite.length)
      expect(report.capabilities.metadataIndex).toBe('indexed')
    }
  )
})
