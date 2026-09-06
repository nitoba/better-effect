// oxlint-disable typescript/await-thenable -- Bun's matcher declarations are Promise-compatible at runtime.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test-only generic Layer erasure is checked by the conformance runner.
// oxlint-disable anti-slop/no-chained-type-assertions -- test-only generic Layer erasure is checked by the conformance runner.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import type { AnyJobScheduleStoreToken } from 'better-effect-mq'
import { jobScheduleStoreContract } from 'better-effect-mq/testing'
import { MongoClient } from 'mongodb'
import { MongoJobScheduleStore, MongoJobStore } from '../../src/index'

const uri = process.env.MONGODB_URL
const integration = uri === undefined ? test.skip : test
const databaseName = process.env.MONGODB_DATABASE ?? `better_effect_mq_schedule_${process.pid}`
const prefix = `better_effect_mq_schedule_${process.pid}`
let client: MongoClient | undefined

const database = () => {
  if (client === undefined) throw new Error('MongoDB integration client is not initialized')
  return client.db(databaseName)
}

const makeNamespace = (id: string) => `${prefix}_${id.replaceAll(/[^A-Za-z0-9_]/gu, '_')}`

type RuntimeEntry = { readonly runtime: Awaited<ReturnType<typeof Runtime.make>> }
const runtimes = new Map<string, RuntimeEntry>()

const runtimeKey = (id: string, token: AnyJobScheduleStoreToken): string =>
  `${id}:${token.serviceTag}`

const openRuntime = async <const Token extends AnyJobScheduleStoreToken>(
  id: string,
  token: Token
) => {
  const namespace = makeNamespace(id)
  const jobLayer = MongoJobStore.layerFor(token.jobStore, {
    db: database(),
    namespace,
    collectionPrefix: prefix
  }) as never
  const scheduleLayer = MongoJobScheduleStore.layerFor(token, {
    db: database(),
    namespace,
    collectionPrefix: prefix
  }) as never
  const layer = Layer.merge(jobLayer, scheduleLayer) as never
  const runtime = (await Runtime.make(layer)) as unknown as Awaited<ReturnType<typeof Runtime.make>>
  runtimes.set(runtimeKey(id, token), { runtime })
  return runtime
}

const suite = jobScheduleStoreContract({
  makeStore: async (context) => {
    const runtime = await openRuntime(context.scenario.id, context.scheduleToken)
    return runtime.run(() => ServiceRuntime.resolve(context.token))
  },
  makeScheduleStore: async (context) => {
    const entry = runtimes.get(runtimeKey(context.scenario.id, context.scheduleToken))
    if (entry === undefined) throw new Error('schedule runtime was not opened')
    return entry.runtime.run(() => ServiceRuntime.resolve(context.scheduleToken))
  },
  reset: async (context) => {
    const entries = [...runtimes.entries()].filter(([key]) => key.startsWith(`${context.id}:`))
    await Promise.all(entries.map(([, entry]) => entry.runtime.dispose()))
    for (const [key] of entries) runtimes.delete(key)
    const db = database()
    const namespace = makeNamespace(context.id)
    const filter = { namespace: { $regex: `^${namespace}` } }
    await Promise.all([
      db.collection(`${prefix}_schedules`).deleteMany(filter),
      db.collection(`${prefix}_attempts`).deleteMany(filter),
      db.collection(`${prefix}_jobs`).deleteMany(filter),
      db.collection(`${prefix}_queues`).deleteMany(filter),
      db.collection(`${prefix}_counters`).deleteMany(filter)
    ])
  }
})

describe('MongoDB JobScheduleStore conformance on a replica set', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    client = new MongoClient(uri, { directConnection: true })
    await client.connect()
    await MongoJobStore.migrate({ db: database(), collectionPrefix: prefix })
  }, 30_000)

  afterAll(async () => {
    for (const entry of runtimes.values()) await entry.runtime.dispose()
    runtimes.clear()
    await client?.close()
  }, 30_000)

  for (const scenario of suite)
    integration(scenario.name, async () => {
      await scenario.run()
    })

  integration('executes every enabled schedule contract scenario', () => {
    const report = suite.report()
    expect(report.failed).toEqual([])
    expect(report.executed).toHaveLength(suite.length)
    expect(report.passed).toHaveLength(suite.length)
    expect(report.descriptor).toEqual({
      extension: 'better-effect-mq/schedules',
      extensionVersion: 1,
      jobStoreProtocolVersion: 1
    })
  })
})
