// oxlint-disable typescript/await-thenable -- Bun's rejection matchers are thenable at runtime.

import { Pool as PgPool } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobStore, type AnyJobStoreToken, type JobStore as JobStoreType } from 'better-effect-mq'
import { jobStoreContract, type JobStoreContractSynchronization } from 'better-effect-mq/testing'
import {
  makeOutboxRecord,
  OutboxId,
  OutboxWorkerId,
  validatePreparedEnqueue
} from 'better-effect-mq-outbox'
import { PostgresClient, PostgresJobStore, PostgresOutbox, type Pool } from '../../src/index'

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

const synchronizeStore = (
  store: JobStoreType.Contract,
  synchronization: JobStoreContractSynchronization
): void => {
  const originalAwaitWake = store.awaitWake.bind(store)
  Object.defineProperty(store, 'awaitWake', {
    configurable: true,
    enumerable: false,
    value: (request: JobStoreType.AwaitWakeRequest) => {
      const waiting = originalAwaitWake(request)
      synchronization.ready()
      return Promise.resolve(waiting).then((result) => {
        synchronization.observed()
        return result
      })
    },
    writable: true
  })
}

const suite = jobStoreContract({
  capabilities: {
    queueFilteredNotifications: true,
    nativeBatchEnqueue: true,
    nativeBatchClaim: true,
    metadataIndex: 'indexed',
    transactionalEnqueue: true,
    durableChangeFeed: false,
    globalConcurrency: true,
    rateLimiting: true
  },
  makeRuntime: async (context) => {
    const runtime = await Runtime.make(
      PostgresJobStore.layer({
        pool: configuredPool(),
        schema,
        namespace,
        validateSchema: false
      })
    )
    await runtime.run(async () => {
      synchronizeStore(await ServiceRuntime.resolve(JobStore), context.synchronization)
    })
    return runtime
  },
  makeMultiStoreRuntime: async (context) => {
    const runtime = await Runtime.make(
      Layer.merge(
        PostgresJobStore.layerFor(context.tokens.default, {
          pool: configuredPool(),
          schema,
          namespace,
          validateSchema: false
        }),
        makeLayer(context.tokens.first),
        makeLayer(context.tokens.second)
      )
    )
    await runtime.run(async () => {
      synchronizeStore(
        await ServiceRuntime.resolve(context.tokens.default),
        context.synchronization
      )
      synchronizeStore(await ServiceRuntime.resolve(context.tokens.first), context.synchronization)
      synchronizeStore(await ServiceRuntime.resolve(context.tokens.second), context.synchronization)
    })
    return runtime
  },
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
      expect(migrated.version).toBe(6)
      expect(migrated.applied).toEqual([1, 2, 3, 4, 5, 6])
      await expect(client.validate()).resolves.toMatchObject({
        schema: migrationSchema,
        version: 6
      })
      await expect(client.migrate()).resolves.toMatchObject({ applied: [] })
    } finally {
      await configuredPgPool().query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`)
    }
  })

  integration('runs the durable outbox append, claim, and settlement paths', async () => {
    const outboxNamespace = `outbox-${process.pid}`
    const store = PostgresOutbox.make({
      pool: configuredPool(),
      schema,
      namespace: outboxNamespace,
      validateSchema: false
    })
    const request = validatePreparedEnqueue({
      protocolVersion: 1,
      identity: { queue: 'billing', name: 'send', version: 1 },
      payload: { orderId: 'real-pg' },
      metadata: {},
      priority: 0,
      runAt: 0,
      attemptsMax: 2,
      now: 0
    }).unwrap()
    const record = makeOutboxRecord({
      id: OutboxId.make('real-pg-outbox').unwrap(),
      target: 'orders',
      request
    }).unwrap()
    const transaction = await configuredPgPool().connect()
    try {
      await transaction.query('BEGIN')
      const appended = await store.appendIn(transaction, record)
      await transaction.query('COMMIT')
      expect(appended.duplicate).toBe(false)
      const claimedResult = await store.claim({
        owner: OutboxWorkerId.make('real-pg-worker').unwrap(),
        limit: 1,
        leaseDurationMs: 1_000,
        nowMs: 0
      })
      if (claimedResult.isErr()) throw claimedResult.error
      const claimed = claimedResult.value[0]
      if (claimed === undefined) throw new Error('The real PostgreSQL outbox claim was empty')
      const settled = await store.markPublished({
        id: claimed.id,
        leaseToken: claimed.leaseToken,
        nowMs: 1
      })
      if (settled.isErr()) throw settled.error
      expect(settled.value.status).toBe('applied')
    } finally {
      await configuredPgPool().query(
        `DELETE FROM "${schema}".better_effect_mq_outbox WHERE namespace = $1`,
        [outboxNamespace]
      )
      await store.dispose()
      transaction.release()
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
    expect(report.capabilities).toEqual({
      queueFilteredNotifications: true,
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
})
