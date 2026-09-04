// oxlint-disable typescript/await-thenable -- Bun matcher declarations are synchronous while runtime matchers await.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import { JobStore, makeQueueName } from 'better-effect-mq'
import { MongoClient } from 'mongodb'
import { MongoJobStore } from '../../src/index'

const uri = process.env.MONGODB_URL
const integration = uri === undefined ? test.skip : test
let client: MongoClient | undefined
let databaseName: string | undefined

describe('MongoDB JobStore replica-set integration', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    client = new MongoClient(uri)
    await client.connect()
    databaseName = `better_effect_mq_mongodb_${process.pid}`
    await MongoJobStore.migrate({ db: client.db(databaseName) })
  })
  afterAll(async () => {
    if (client === undefined || databaseName === undefined) return
    await client.db(databaseName).dropDatabase()
    await client.close()
  })
  integration('migrates a replica-set layout and persists an enqueue', async () => {
    if (client === undefined || databaseName === undefined)
      throw new Error('MongoDB test was not initialized')
    const runtime = await Runtime.make(MongoJobStore.layer({ db: client.db(databaseName) }))
    try {
      const enqueued = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        return store.enqueue({
          job: { queue: makeQueueName('default').unwrap(), name: 'integration', version: 1 },
          payload: { adapter: 'mongodb' },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
      })
      expect(enqueued.isOk()).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
