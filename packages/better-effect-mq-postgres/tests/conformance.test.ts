// oxlint-disable typescript/await-thenable -- PGlite and Bun test declarations are Promise-compatible at runtime.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the PGlite bridge narrows its driver result at this test boundary.

import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobEventStore, JobStore, type AnyJobStoreToken } from 'better-effect-mq'
import { jobEventStoreContract, jobStoreContract } from 'better-effect-mq/testing'
import {
  PostgresClient,
  PostgresJobEventStore,
  PostgresJobStore,
  type Pool,
  type PoolClient,
  type QueryResult
} from '../src/index'

type PGliteDatabase = Awaited<ReturnType<typeof PGlite.create>>
type PGliteQueryResult<Row> = {
  readonly rows: readonly Row[]
  readonly affectedRows?: number
}

const schema = 'mq_conformance_test'
const namespace = 'contract'
let database: PGliteDatabase
let pool: Pool
let eventRuntime: Awaited<ReturnType<typeof Runtime.make>> | undefined
let eventStore: JobEventStore.Contract | undefined
let eventJobStore: JobStore.Contract | undefined

const runQuery = async <Row>(
  text: string,
  values: readonly unknown[] | undefined
): Promise<PGliteQueryResult<Row>> => {
  if (values === undefined && !/^\s*(SELECT|WITH)/iu.test(text)) {
    await database.exec(text)
    return { rows: [] }
  }
  return (
    values === undefined ? database.query(text) : database.query(text, [...values])
  ) as Promise<PGliteQueryResult<Row>>
}

beforeAll(async () => {
  database = await PGlite.create('memory://')
  pool = {
    connect: async (): Promise<PoolClient> => ({
      query: async <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
        const result = await runQuery<Row>(text, values)
        return {
          rows: result.rows,
          rowCount: result.affectedRows ?? result.rows.length
        }
      },
      release: () => undefined
    })
  }
  await PostgresClient.fromPool({ pool, schema }).migrate({ appliedAtMs: 1 })
  eventRuntime = await Runtime.make(
    Layer.merge(
      PostgresJobStore.layer({ pool, schema, namespace, validateSchema: false }),
      PostgresJobEventStore.layer({ pool, schema, namespace, validateSchema: false })
    )
  )
  await eventRuntime.run(async () => {
    eventStore = await ServiceRuntime.resolve(JobEventStore)
    eventJobStore = await ServiceRuntime.resolve(JobStore)
  })
})

afterAll(async () => {
  await eventRuntime?.dispose()
  await database.close()
})

const makeLayer = <const Token extends AnyJobStoreToken>(token: Token) =>
  PostgresJobStore.layerFor(token, {
    pool,
    schema,
    namespace,
    validateSchema: false
  })

const suite = jobStoreContract({
  // PGlite exercises SQL semantics but has no PostgreSQL LISTEN/NOTIFY channel.
  capabilities: {
    queueFilteredNotifications: false,
    nativeBatchEnqueue: true,
    nativeBatchClaim: true,
    metadataIndex: 'indexed',
    transactionalEnqueue: true,
    durableChangeFeed: false,
    globalConcurrency: true,
    rateLimiting: true
  },
  makeRuntime: async () => {
    const runtime = await Runtime.make(
      PostgresJobStore.layer({ pool, schema, namespace, validateSchema: false })
    )
    await runtime.run(async () => {
      const store = await ServiceRuntime.resolve(JobStore)
      await store.pausedQueues()
    })
    return runtime
  },
  makeMultiStoreRuntime: async () => {
    const runtime = await Runtime.make(
      Layer.merge(
        PostgresJobStore.layer({ pool, schema, namespace, validateSchema: false }),
        makeLayer(JobStore.named('contract-store-a')),
        makeLayer(JobStore.named('contract-store-b'))
      )
    )
    await runtime.run(async () => {
      const stores = await Promise.all([
        ServiceRuntime.resolve(JobStore),
        ServiceRuntime.resolve(JobStore.named('contract-store-a')),
        ServiceRuntime.resolve(JobStore.named('contract-store-b'))
      ])
      await Promise.all(stores.map((store) => store.pausedQueues()))
    })
    return runtime
  },
  reset: async () => {
    await database.exec(
      `DELETE FROM "${schema}".better_effect_mq_job_events;
       DELETE FROM "${schema}".better_effect_mq_job_event_cursors;
       DELETE FROM "${schema}".better_effect_mq_attempts;
       DELETE FROM "${schema}".better_effect_mq_jobs;
       DELETE FROM "${schema}".better_effect_mq_queues;`
    )
  }
})

const eventSuite = jobEventStoreContract({
  makeEventStore: () => {
    if (eventStore === undefined) throw new Error('event store runtime is not initialized')
    return eventStore
  },
  makeJobStore: () => {
    if (eventJobStore === undefined) throw new Error('job store runtime is not initialized')
    return eventJobStore
  }
})

describe('PostgreSQL JobStore conformance via PGlite', () => {
  for (const scenario of suite) {
    test(scenario.name, async () => {
      await scenario.run()
    })
  }

  test('executes every enabled contract scenario', () => {
    const report = suite.report()
    expect(report.failed).toEqual([])
    expect(report.executed).toHaveLength(suite.length)
    expect(report.passed).toHaveLength(suite.length)
    expect(report.capabilities).toEqual({
      queueFilteredNotifications: false,
      nativeBatchEnqueue: true,
      nativeBatchClaim: true,
      metadataIndex: 'indexed',
      transactionalEnqueue: true,
      durableChangeFeed: false,
      globalConcurrency: true,
      rateLimiting: true
    })
    expect(report.descriptor?.capabilities).toEqual(report.capabilities)
    expect(report.capabilitiesNotTested).toEqual(['globalConcurrency', 'rateLimiting'])
  })

  for (const scenario of eventSuite) {
    test(`event extension: ${scenario.name}`, async () => {
      await database.exec(
        `DELETE FROM "${schema}".better_effect_mq_job_events;
         DELETE FROM "${schema}".better_effect_mq_job_event_cursors;
         DELETE FROM "${schema}".better_effect_mq_attempts;
         DELETE FROM "${schema}".better_effect_mq_jobs;
         DELETE FROM "${schema}".better_effect_mq_queues;`
      )
      await scenario.run()
    })
  }

  test('executes every durable event contract scenario', () => {
    const report = eventSuite.report()
    expect(report.failed).toEqual([])
    expect(report.executed).toHaveLength(eventSuite.length)
    expect(report.passed).toHaveLength(eventSuite.length)
  })
})
