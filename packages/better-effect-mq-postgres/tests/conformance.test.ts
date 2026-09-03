// oxlint-disable typescript/await-thenable -- PGlite and Bun test declarations are Promise-compatible at runtime.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the PGlite bridge narrows its driver result at this test boundary.

import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime } from 'better-effect'
import { JobStore, type AnyJobStoreToken } from 'better-effect-mq'
import { jobStoreContract } from 'better-effect-mq/testing'
import {
  PostgresClient,
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
})

afterAll(async () => {
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
  capabilities: { batchClaim: true, transactionalEnqueue: true },
  makeRuntime: async () =>
    Runtime.make(PostgresJobStore.layer({ pool, schema, namespace, validateSchema: false })),
  makeMultiStoreRuntime: async () =>
    Runtime.make(
      Layer.merge(
        PostgresJobStore.layer({ pool, schema, namespace, validateSchema: false }),
        makeLayer(JobStore.named('contract-store-a')),
        makeLayer(JobStore.named('contract-store-b'))
      )
    ),
  reset: async () => {
    await database.exec(
      `DELETE FROM "${schema}".better_effect_mq_attempts;
       DELETE FROM "${schema}".better_effect_mq_jobs;
       DELETE FROM "${schema}".better_effect_mq_queues;`
    )
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
  })
})
