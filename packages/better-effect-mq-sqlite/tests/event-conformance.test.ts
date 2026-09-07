import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import {
  JobEventStore,
  JobStore,
  type JobEventStore as JobEventStoreType,
  type JobStore as JobStoreType
} from 'better-effect-mq'
import { jobEventStoreContract } from 'better-effect-mq/testing'
import { SqliteJobStore } from '../src'

const database = new Database(':memory:')
let runtime: Awaited<ReturnType<typeof Runtime.make>>
let eventStore: JobEventStoreType.Contract
let jobStore: JobStoreType.Contract

beforeAll(async () => {
  SqliteJobStore.migrate({ database })
  runtime = await Runtime.make(
    SqliteJobStore.layerWithEvents({ database, namespace: 'event-contract', pollIntervalMs: 10 })
  )
  await runtime.run(async () => {
    eventStore = await ServiceRuntime.resolve(JobEventStore)
    jobStore = await ServiceRuntime.resolve(JobStore)
  })
})

afterAll(async () => {
  await runtime.dispose()
  database.close()
})

const suite = jobEventStoreContract({
  makeEventStore: () => eventStore,
  makeJobStore: () => jobStore
})

describe('SQLite JobEventStore conformance', () => {
  for (const scenario of suite) {
    test(scenario.name, async () => {
      database.exec(`
        DELETE FROM better_effect_mq_job_events;
        DELETE FROM better_effect_mq_job_event_cursors;
        DELETE FROM better_effect_mq_attempts;
        DELETE FROM better_effect_mq_jobs;
        DELETE FROM better_effect_mq_queues;
        DELETE FROM better_effect_mq_sqlite_state;
      `)
      await scenario.run()
    })
  }

  test('executes every durable event contract scenario', () => {
    const report = suite.report()
    expect(report.failed).toEqual([])
    expect(report.executed).toHaveLength(suite.length)
    expect(report.passed).toHaveLength(suite.length)
  })
})
