// oxlint-disable typescript/await-thenable -- Bun's test declarations are sync while scenario execution is async.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime } from 'better-effect'
import { JobStore, type AnyJobStoreToken } from 'better-effect-mq'
import { jobStoreContract } from 'better-effect-mq/testing'
import { MongoClient } from 'mongodb'
import { MongoJobStore } from '../src/index'

const uri = process.env.MONGODB_URL
const integration = uri === undefined ? test.skip : test
const database = `better_effect_mq_mongodb_contract_${process.pid}`
let client: MongoClient | undefined

beforeAll(async () => {
  if (uri === undefined) return
  client = new MongoClient(uri)
  await client.connect()
  await MongoJobStore.migrate({ db: client.db(database) })
})
afterAll(async () => {
  if (client === undefined) return
  await client.db(database).dropDatabase()
  await client.close()
})

const runtime = async () => {
  if (client === undefined) throw new Error('MONGODB_URL is required for MongoDB conformance')
  return Runtime.make(MongoJobStore.layer({ db: client.db(database) }))
}
const storeLayer = <T extends AnyJobStoreToken>(token: T) => {
  if (client === undefined) throw new Error('MONGODB_URL is required for MongoDB conformance')
  return MongoJobStore.layerFor(token, { db: client.db(database) })
}
const suite = jobStoreContract({
  capabilities: {
    queueFilteredNotifications: false,
    nativeBatchEnqueue: true,
    nativeBatchClaim: true,
    metadataIndex: 'indexed',
    transactionalEnqueue: true,
    durableChangeFeed: false,
    globalConcurrency: false,
    rateLimiting: false
  },
  makeRuntime: runtime,
  makeMultiStoreRuntime: async () =>
    Runtime.make(
      Layer.merge(
        MongoJobStore.layer({ db: client!.db(database) }),
        storeLayer(JobStore.named('contract-store-a')),
        storeLayer(JobStore.named('contract-store-b'))
      )
    ),
  reset: async () => {
    if (client === undefined) return
    await Promise.all(
      ['attempts', 'jobs', 'queues', 'counters'].map((name) =>
        client!.db(database).collection(`better_effect_mq_${name}`).deleteMany({})
      )
    )
  }
})

describe('MongoDB JobStore replica-set conformance', () => {
  for (const scenario of suite) integration(scenario.name, scenario.run)
  integration('executes every enabled contract scenario', () => {
    const report = suite.report()
    expect(report.failed).toEqual([])
    expect(report.executed).toHaveLength(suite.length)
  })
})
