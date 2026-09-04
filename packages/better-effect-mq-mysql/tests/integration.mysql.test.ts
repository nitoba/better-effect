// oxlint-disable typescript/await-thenable -- Bun's rejection matchers are thenable at runtime.

import { createPool, type Pool as MySqlPool, type RowDataPacket } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobStore, type AnyJobStoreToken, type JobStore as JobStoreType } from 'better-effect-mq'
import { jobStoreContract, type JobStoreContractSynchronization } from 'better-effect-mq/testing'
import {
  MIGRATION_COMPONENT,
  MYSQL_TABLES,
  MySqlClient,
  MySqlJobStore,
  loadMySqlMigrations,
  migrationManifestChecksum
} from '../src'

const uri = process.env.MYSQL_URL
const namespace = `mysql_contract_${process.pid}`
let pool: MySqlPool | undefined
let upgradeApplied: readonly number[] = []
let upgradedColumns = new Map<string, string>()

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
const statements = (sql: string): readonly string[] =>
  sql
    .split(/;\s*(?:\r?\n|$)/u)
    .map((statement) => statement.trim())
    .filter(Boolean)
const legacyInitialSql = (sql: string): string =>
  sql
    .replace(
      'UNIQUE KEY better_effect_mq_jobs_idempotency_idx (namespace, queue, name, version, dedupe_key)',
      'UNIQUE KEY better_effect_mq_jobs_idempotency_idx (namespace(191), queue(191), name(191), version, dedupe_key(191))'
    )
    .replace(
      'KEY better_effect_mq_jobs_claim_idx (namespace, queue, state, priority DESC, run_at_ms ASC, sequence ASC, id ASC)',
      'KEY better_effect_mq_jobs_claim_idx (namespace(191), queue(191), state, priority DESC, run_at_ms ASC, sequence ASC, id(191) ASC)'
    )
    .replace(
      'KEY better_effect_mq_jobs_identity_idx (namespace, queue, name, version, state)',
      'KEY better_effect_mq_jobs_identity_idx (namespace(191), queue(191), name(191), version, state)'
    )
    .replace(
      'KEY better_effect_mq_jobs_recent_idx (namespace, created_at_ms DESC, sequence DESC, id DESC)',
      'KEY better_effect_mq_jobs_recent_idx (namespace(191), created_at_ms DESC, sequence DESC, id(191) DESC)'
    )
    .replace(
      'KEY better_effect_mq_jobs_run_at_idx (namespace, queue, state, run_at_ms, sequence, id)',
      'KEY better_effect_mq_jobs_run_at_idx (namespace(191), queue(191), state, run_at_ms, sequence, id(191))'
    )
    .replace(
      'KEY better_effect_mq_jobs_terminal_idx (namespace, state, finished_at_ms DESC, sequence DESC, id DESC)',
      'KEY better_effect_mq_jobs_terminal_idx (namespace(191), state, finished_at_ms DESC, sequence DESC, id(191) DESC)'
    )
    .replace(
      'KEY better_effect_mq_attempts_order_idx (namespace, job_id, ledger_sequence)',
      'KEY better_effect_mq_attempts_sequence_idx (ledger_sequence), KEY better_effect_mq_attempts_order_idx (namespace, job_id, ledger_sequence)'
    )
const dropLayout = async (): Promise<void> => {
  const sql = configuredPool()
  await sql.query('SET FOREIGN_KEY_CHECKS = 0')
  try {
    for (const table of [
      MYSQL_TABLES.attempts,
      MYSQL_TABLES.jobs,
      MYSQL_TABLES.queues,
      MYSQL_TABLES.orderingSequences,
      MYSQL_TABLES.schemaVersions
    ])
      await sql.query(`DROP TABLE IF EXISTS ${table}`)
  } finally {
    await sql.query('SET FOREIGN_KEY_CHECKS = 1')
  }
}
const installLegacyLayout = async (): Promise<void> => {
  const migrations = await loadMySqlMigrations()
  const initial = migrations[0]
  if (initial === undefined) throw new Error('MySQL migration 001 is missing')
  for (const statement of statements(legacyInitialSql(initial.sql)))
    await configuredPool().query(statement)
  await configuredPool().query(
    `CREATE TABLE ${MYSQL_TABLES.schemaVersions} (component VARCHAR(255) NOT NULL PRIMARY KEY, version INT NOT NULL, applied_at_ms BIGINT NOT NULL, checksum CHAR(64) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'applied', CHECK (component <> '' AND version >= 0 AND checksum <> '')) ENGINE=InnoDB`
  )
  await configuredPool().query(
    `INSERT INTO ${MYSQL_TABLES.schemaVersions} (component, version, applied_at_ms, checksum, status) VALUES (?, 1, 0, ?, 'applied')`,
    [MIGRATION_COMPONENT, migrationManifestChecksum(migrations, 1)]
  )
}

describe('MySQL JobStore conformance on MySQL 8.0.16+', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    pool = createPool({ uri, connectionLimit: 12 })
    const client = MySqlClient.fromPool({ pool: configuredPool(), namespace })
    expect(await client.migrate()).toMatchObject({ version: 2, applied: [1, 2] })
    await dropLayout()
    await installLegacyLayout()
    const upgrade = await client.migrate()
    expect(upgrade).toMatchObject({ version: 2, applied: [2] })
    upgradeApplied = upgrade.applied
    const [columns] = await configuredPool().query<
      Array<
        RowDataPacket & {
          column_name: string
          data_type: string
        }
      >
    >(
      `SELECT column_name AS column_name, data_type AS data_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name IN ('dedupe_hash', 'last_settlement_outcome')`,
      [MYSQL_TABLES.jobs]
    )
    upgradedColumns = new Map(columns.map((column) => [column.column_name, column.data_type]))
  }, 30_000)
  afterAll(async () => {
    await pool?.end()
  })

  integration('migrates fresh layouts and upgrades an existing v1 MySQL layout', async () => {
    const client = MySqlClient.fromPool({ pool: configuredPool(), namespace })
    expect(upgradeApplied).toEqual([2])
    expect(upgradedColumns).toEqual(
      new Map([
        ['dedupe_hash', 'binary'],
        ['last_settlement_outcome', 'longtext']
      ])
    )
    await expect(client.validate()).resolves.toMatchObject({ version: 2 })
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
