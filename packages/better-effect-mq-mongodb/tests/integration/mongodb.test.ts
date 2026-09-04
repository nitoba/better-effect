// oxlint-disable typescript/await-thenable -- Bun matcher declarations are synchronous while runtime matchers await.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import { JobStore, makeJobId, makeQueueName, makeWorkerId } from 'better-effect-mq'
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

  integration('mutates only the claimed document and writes its attempt ledger', async () => {
    if (client === undefined || databaseName === undefined)
      throw new Error('MongoDB test was not initialized')
    const db = client.db(databaseName)
    const runtime = await Runtime.make(MongoJobStore.layer({ db, namespace: 'document-ops' }))
    const queue = makeQueueName('default').unwrap()
    try {
      const result = await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const first = await store.enqueue({
          id: makeJobId('document-operations-job').unwrap(),
          job: { queue, name: 'documentOperations', version: 1 },
          payload: { first: true },
          runAt: 10,
          attemptsMax: 1,
          now: 10
        })
        const second = await store.enqueue({
          id: makeJobId('document-operations-other').unwrap(),
          job: { queue, name: 'documentOperations', version: 1 },
          payload: { second: true },
          runAt: 10,
          attemptsMax: 1,
          now: 10
        })
        if (first.isErr() || second.isErr()) return first.isErr() ? first : second
        const claimed = await store.claim({
          queue,
          accepted: [{ queue, name: 'documentOperations', version: 1 }],
          limit: 1,
          workerId: makeWorkerId('mongodb-integration').unwrap(),
          leaseDurationMs: 1_000,
          now: 11
        })
        if (claimed.isErr()) return claimed
        const active = claimed.value.jobs[0]
        if (active === undefined) throw new Error('expected one claimed job')
        return store.settle({
          jobId: active.id,
          leaseToken: active.leaseToken,
          outcome: { type: 'complete', result: { done: true } },
          now: 12
        })
      })
      expect(result.isOk()).toBe(true)
      const jobs = await db
        .collection('better_effect_mq_jobs')
        .find({ namespace: 'document-ops' })
        .toArray()
      const attempts = await db
        .collection('better_effect_mq_attempts')
        .find({ namespace: 'document-ops' })
        .toArray()
      expect(jobs).toHaveLength(2)
      expect(jobs.filter((job) => job.state === 'completed')).toHaveLength(1)
      expect(attempts).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })
})
