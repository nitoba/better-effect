// oxlint-disable typescript/await-thenable -- Bun's rejection matchers are thenable at runtime.

import { Pool as PgPool } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime } from 'better-effect'
import { JobStore, type AnyJobStoreToken } from 'better-effect-mq'
import { jobStoreContract } from 'better-effect-mq/testing'
import { PostgresClient, PostgresJobStore, type Pool } from '../../src/index'

const connectionString = process.env.POSTGRES_URL
const schema = `better_effect_mq_contract_${process.pid}`
const namespace = 'contract'
let pool: PgPool | undefined

const configuredPgPool = (): PgPool => {
  if (pool === undefined) throw new Error('PostgreSQL pool was not initialized')
  return pool
}

const configuredPool = (): Pool => configuredPgPool()

const makeLayer = <const Token extends AnyJobStoreToken>(token: Token) =>
  PostgresJobStore.layerFor(token, {
    pool: configuredPool(),
    schema,
    namespace,
    validateSchema: false
  })

const suite = jobStoreContract({
  capabilities: { batchClaim: true, transactionalEnqueue: true },
  makeRuntime: async () =>
    Runtime.make(
      PostgresJobStore.layer({
        pool: configuredPool(),
        schema,
        namespace,
        validateSchema: false
      })
    ),
  makeMultiStoreRuntime: async () =>
    Runtime.make(
      Layer.merge(
        PostgresJobStore.layer({
          pool: configuredPool(),
          schema,
          namespace,
          validateSchema: false
        }),
        makeLayer(JobStore.named('contract-store-a')),
        makeLayer(JobStore.named('contract-store-b'))
      )
    ),
  reset: async () => {
    await pool?.query(`
      DELETE FROM "${schema}".better_effect_mq_attempts;
      DELETE FROM "${schema}".better_effect_mq_jobs;
      DELETE FROM "${schema}".better_effect_mq_queues;
    `)
  }
})

const integration = connectionString === undefined ? test.skip : test

describe('PostgreSQL JobStore conformance on PostgreSQL', () => {
  beforeAll(async () => {
    if (connectionString === undefined) return
    pool = new PgPool({ connectionString })
    const client = PostgresClient.fromPool({ pool, schema })
    await client.migrate()
  })

  afterAll(async () => {
    if (pool === undefined) return
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await pool.end()
  })

  integration('migrates and validates a real database', async () => {
    const migrationSchema = `better_effect_mq_migration_${process.pid}`
    const client = PostgresClient.fromPool({ pool: configuredPool(), schema: migrationSchema })
    try {
      await configuredPgPool().query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`)
      const migrated = await client.migrate()
      expect(migrated.version).toBe(1)
      expect(migrated.applied).toEqual([1])
      await expect(client.validate()).resolves.toMatchObject({
        schema: migrationSchema,
        version: 1
      })
      await expect(client.migrate()).resolves.toMatchObject({ applied: [] })
    } finally {
      await configuredPgPool().query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`)
    }
  })

  for (const scenario of suite) {
    integration(scenario.name, async () => {
      await scenario.run()
    })
  }

  integration('executes every enabled contract scenario', () => {
    const report = suite.report()
    expect(report.failed).toEqual([])
    expect(report.executed).toHaveLength(suite.length)
    expect(report.passed).toHaveLength(suite.length)
  })
})
