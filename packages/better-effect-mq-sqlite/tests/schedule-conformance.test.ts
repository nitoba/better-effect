import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { JobStore } from 'better-effect-mq'
import {
  jobScheduleStoreContract,
  type JobScheduleStoreContractScheduleContext,
  type JobScheduleStoreContractStoreContext
} from 'better-effect-mq/testing'
import { SqliteJobScheduleStore, SqliteJobStore } from '../src'

const databases = new Map<string, Database>()

const namespaceFor = (token: { readonly serviceTag: string }, namespace: string): string =>
  token.serviceTag === JobStore.serviceTag
    ? namespace
    : `${namespace}:${encodeURIComponent(token.serviceTag)}`

const databaseFor = (id: string): Database => {
  const database = databases.get(id)
  if (database === undefined) throw new Error(`missing database for ${id}`)
  return database
}

const suite = jobScheduleStoreContract({
  setup(context) {
    const database = new Database(':memory:')
    SqliteJobStore.migrate({ database })
    databases.set(context.id, database)
  },
  makeStore(context: JobScheduleStoreContractStoreContext) {
    return SqliteJobStore.make({
      database: databaseFor(context.scenario.id),
      namespace: namespaceFor(context.token, 'default')
    })
  },
  makeScheduleStore(context: JobScheduleStoreContractScheduleContext) {
    return SqliteJobScheduleStore.make({
      database: databaseFor(context.scenario.id),
      namespace: namespaceFor(context.token, 'default')
    })
  },
  reset(context) {
    databases.get(context.id)?.close()
    databases.delete(context.id)
  }
})

describe('SQLite JobScheduleStore extension conformance', () => {
  for (const scenario of suite) test(scenario.name, scenario.run)
  test('executes every schedule conformance scenario', () => {
    const report = suite.report()
    expect(report.failed).toEqual([])
    expect(report.executed).toHaveLength(suite.length)
  })
})
