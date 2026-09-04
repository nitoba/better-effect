// oxlint-disable typescript/await-thenable -- Bun's rejection matchers are thenable at runtime.

import { createPool, type Pool as MySqlPool } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobStore, type AnyJobStoreToken, type JobStore as JobStoreType } from 'better-effect-mq'
import { jobStoreContract, type JobStoreContractSynchronization } from 'better-effect-mq/testing'
import { MySqlClient, MySqlJobStore } from '../src'

const uri = process.env.MYSQL_URL
const namespace = `mysql_contract_${process.pid}`
let pool: MySqlPool | undefined

const configuredPool = (): MySqlPool => {
  if (pool === undefined) throw new Error('MYSQL_URL did not initialize a pool')
  return pool
}
const makeLayer = <const Token extends AnyJobStoreToken>(token: Token) =>
  MySqlJobStore.layerFor(token, {
    pool: configuredPool(),
    namespace,
    validateSchema: false
  })
const synchronizeStore = (
  store: JobStoreType.Contract,
  synchronization: JobStoreContractSynchronization
): void => {
  const awaitWake = store.awaitWake.bind(store)
  Object.defineProperty(store, 'awaitWake', {
    configurable: true,
    enumerable: false,
    value: (request: JobStoreType.AwaitWakeRequest) => {
      const waiting = awaitWake(request)
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
    metadataIndex: 'residual',
    transactionalEnqueue: true,
    durableChangeFeed: false,
    globalConcurrency: false,
    rateLimiting: false
  },
  makeRuntime: async (context) => {
    const runtime = await Runtime.make(
      MySqlJobStore.layer({ pool: configuredPool(), namespace, validateSchema: false })
    )
    await runtime.run(async () => {
      synchronizeStore(await ServiceRuntime.resolve(JobStore), context.synchronization)
    })
    return runtime
  },
  makeMultiStoreRuntime: async (context) => {
    const runtime = await Runtime.make(
      Layer.merge(
        MySqlJobStore.layerFor(context.tokens.default, {
          pool: configuredPool(),
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
    const sql = configuredPool()
    await sql.query(
      `DELETE attempts FROM better_effect_mq_attempts attempts JOIN better_effect_mq_jobs jobs ON jobs.namespace = attempts.namespace AND jobs.id = attempts.job_id WHERE jobs.namespace LIKE ?`,
      [`${namespace}%`]
    )
    await sql.query('DELETE FROM better_effect_mq_jobs WHERE namespace LIKE ?', [`${namespace}%`])
    await sql.query('DELETE FROM better_effect_mq_queues WHERE namespace LIKE ?', [`${namespace}%`])
  }
})
const integration = uri === undefined ? test.skip : test

describe('MySQL JobStore conformance on MySQL 8.0.16+', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    pool = createPool({ uri, connectionLimit: 12 })
    await MySqlClient.fromPool({ pool: configuredPool(), namespace }).migrate()
  })
  afterAll(async () => {
    await pool?.end()
  })

  integration('migrates and validates a real MySQL database', async () => {
    const client = MySqlClient.fromPool({ pool: configuredPool(), namespace })
    await expect(client.validate()).resolves.toMatchObject({ version: 1 })
    await expect(client.migrate()).resolves.toMatchObject({ applied: [] })
  })
  for (const scenario of suite)
    integration(scenario.name, async () => {
      await scenario.run()
    })
  integration(
    'executes transitions, pause, wake, fencing, settlement replay, and named-store coverage',
    () => {
      const report = suite.report()
      expect(report.failed).toEqual([])
      expect(report.executed).toHaveLength(suite.length)
      expect(report.passed).toHaveLength(suite.length)
      expect(report.capabilities.metadataIndex).toBe('residual')
    }
  )
})
