import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Runtime, ServiceRuntime } from 'better-effect'
import { JobStore } from 'better-effect-mq'
import { Result } from 'better-result'
import { Pool } from 'pg'
import type { QueryResultRow } from 'pg'
import { PostgresJobStore, PostgresMigrator } from '../../src/index'
import type { Pool as AdapterPool, PoolClient, QueryResult } from '../../src/index'

type QueryValues = Parameters<PoolClient['query']>[1]

async function verifyDrain(
  pool: Pool,
  schema: string,
  outcome: 'COMMIT' | 'ROLLBACK'
): Promise<void> {
  const entered = Promise.withResolvers<void>()
  const permit = Promise.withResolvers<void>()
  const events: string[] = []
  let hold = true
  // Native SQL still executes against PostgreSQL. Only the transaction's final
  // query is gated to make disposal ordering reproducible without timing luck.
  const gated: AdapterPool = {
    async connect(): Promise<PoolClient> {
      const client = await pool.connect()
      return {
        async query<Row>(text: string, values?: QueryValues): Promise<QueryResult<Row>> {
          if (outcome === 'ROLLBACK' && text.startsWith('SELECT queue FROM')) {
            throw new Error('Injected transaction body failure')
          }
          if (text === outcome && hold) {
            hold = false
            entered.resolve()
            await permit.promise
          }
          const result = await client.query<Row & QueryResultRow>(
            text,
            values === undefined ? undefined : [...values]
          )
          if (text === outcome) events.push(outcome)
          return result
        },
        release(error?: Error): void {
          events.push('released')
          client.release(error)
        }
      }
    }
  }
  const runtime = await Runtime.make(
    PostgresJobStore.layer({ pool: gated, schema, validateSchema: false })
  )
  const jobs = await runtime.run(() => ServiceRuntime.resolve(JobStore))
  const pending = jobs.pausedQueues()
  await entered.promise
  let disposed = false
  const closing = runtime.dispose().then(() => {
    disposed = true
    events.push('disposed')
  })
  try {
    // This wrapper has no notification listener: all early-disposal work is
    // synchronous/microtask-based, while native transaction completion is gated.
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(disposed, false, `Disposal returned before ${outcome} and client release`)
  } finally {
    permit.resolve()
    await pending
    await closing
  }
  assert.deepEqual(events, [outcome, 'released', 'disposed'])
  const result = await pending
  assert.equal(Result.isOk(result), outcome === 'COMMIT')
  assert.ok(
    Result.isError(await jobs.pausedQueues()),
    'Closed storage must reject new transactions'
  )
  assert.equal((await pool.query<{ value: number }>('SELECT 1 AS value')).rows[0]?.value, 1)
  console.log(
    `PASS: borrowed-store disposal drains ${outcome}, releases its client and leaves the native pool usable`
  )
}

const connectionString = process.env.MQ_TEST_DATABASE_URL
assert.ok(connectionString, 'MQ_TEST_DATABASE_URL must point to a dedicated test database')
const deadline = setTimeout(() => {
  console.error('FAIL: admitted-transaction disposal did not finish within the regression deadline')
  process.exit(1)
}, 15_000)
deadline.unref()
const schema = `mq_dispose_${randomUUID().replaceAll('-', '')}`
const pool = new Pool({ connectionString, max: 4 })
try {
  await PostgresMigrator.run(pool, { schema })
  await verifyDrain(pool, schema, 'COMMIT')
  await verifyDrain(pool, schema, 'ROLLBACK')
} finally {
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await pool.end()
    clearTimeout(deadline)
  }
}
