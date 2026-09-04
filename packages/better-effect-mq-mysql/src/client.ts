// oxlint-disable anti-slop/no-runtime-typeof -- this module normalizes the optional mysql2 driver boundary.
// oxlint-disable anti-slop/no-unknown-returns -- mysql2 exposes untyped result tuples which are normalized here.
// oxlint-disable anti-slop/no-unknown-parameters -- mysql2 result values are parsed at this boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- tuple result erasure is localized at the driver boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions are limited to the checked mysql2 structural boundary.

import { Service } from 'better-effect'
import {
  normalizeMySqlJobStoreConfig,
  normalizeMySqlJobStoreConnectionConfig,
  type MySqlJobStoreConfig,
  type MySqlJobStoreConnectionConfig,
  type Pool,
  type PoolConnection,
  type QueryResult
} from './config'
import { MySqlConfigurationError, redactedMySqlError } from './errors'
import type {
  MySqlMigrationOptions,
  MySqlMigrationResult,
  MySqlSchemaValidationResult
} from './migrator'

export class MySqlClient extends Service<MySqlClient>()('MySqlClient') {
  readonly pool: AdapterPool
  readonly namespace: string
  readonly validateSchema: boolean
  readonly ownsPool: boolean
  private disposal: Promise<void> | undefined

  constructor(pool: Pool, config: Omit<MySqlJobStoreConfig, 'pool'>, ownsPool: boolean) {
    super()
    const normalized = normalizeMySqlJobStoreConfig({ ...config, pool })
    this.pool = adaptPool(normalized.pool)
    this.namespace = normalized.namespace
    this.validateSchema = normalized.validateSchema
    this.ownsPool = ownsPool
  }

  static fromPool(config: MySqlJobStoreConfig): MySqlClient
  static fromPool(pool: Pool, options?: Omit<MySqlJobStoreConfig, 'pool'>): MySqlClient
  static fromPool(
    configOrPool: MySqlJobStoreConfig | Pool,
    options: Omit<MySqlJobStoreConfig, 'pool'> = {}
  ): MySqlClient {
    if (isPoolConfig(configOrPool)) {
      const normalized = normalizeMySqlJobStoreConfig(configOrPool)
      return new MySqlClient(normalized.pool, normalized, false)
    }
    const normalized = normalizeMySqlJobStoreConfig({ ...options, pool: configOrPool })
    return new MySqlClient(normalized.pool, normalized, false)
  }

  /** `mysql2` is loaded only when the adapter owns the pool. */
  static async fromConfig(config: MySqlJobStoreConnectionConfig): Promise<MySqlClient> {
    const normalized = normalizeMySqlJobStoreConnectionConfig(config)
    try {
      const driver = await import('mysql2/promise')
      const options = Object.assign(
        {},
        normalized.poolConfig,
        normalized.uri === undefined ? {} : { uri: normalized.uri }
      )
      const pool = driver.createPool(options)
      return new MySqlClient(pool, normalized, true)
    } catch (cause) {
      if (cause instanceof MySqlConfigurationError) throw cause
      throw redactedMySqlError('client configuration', cause)
    }
  }

  async migrate(options?: MySqlMigrationOptions): Promise<MySqlMigrationResult> {
    const { MySqlMigrator } = await import('./migrator')
    return MySqlMigrator.run(this, options)
  }
  async validate(): Promise<MySqlSchemaValidationResult> {
    const { MySqlMigrator } = await import('./migrator')
    return MySqlMigrator.validate(this)
  }
  async compatibility(): Promise<void> {
    const { assertMySqlCompatibility } = await import('./migrator')
    const connection = await this.pool.getConnection()
    try {
      await assertMySqlCompatibility(connection)
    } finally {
      connection.release()
    }
  }
  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposal =
      this.ownsPool && this.pool.end !== undefined
        ? Promise.resolve(this.pool.end())
        : Promise.resolve()
    try {
      await this.disposal
    } catch (cause) {
      throw redactedMySqlError('pool shutdown', cause)
    }
  }
  async close(): Promise<void> {
    return this.dispose()
  }
  async [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }
}

const isPoolConfig = (value: MySqlJobStoreConfig | Pool): value is MySqlJobStoreConfig =>
  value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'pool')

interface AdapterPool {
  getConnection(): PromiseLike<PoolConnection>
  end?(): PromiseLike<void>
}

const adaptPool = (pool: Pool): AdapterPool => {
  const adapter: AdapterPool = {
    getConnection: async () => {
      const connection = (await pool.getConnection()) as {
        readonly query: (sql: string, values?: readonly unknown[]) => PromiseLike<unknown>
        readonly execute?: (sql: string, values?: readonly unknown[]) => PromiseLike<unknown>
        readonly beginTransaction: () => PromiseLike<void>
        readonly commit: () => PromiseLike<void>
        readonly rollback: () => PromiseLike<void>
        readonly release: () => void
      }
      const run = async <Row>(sql: string, values?: readonly unknown[]) => {
        const output = await connection.query(sql, values)
        if (isQueryResult<Row>(output)) return output
        const rows = Array.isArray(output) ? output[0] : undefined
        const info = Array.isArray(rows) ? undefined : rows
        return {
          rows: (Array.isArray(rows) ? rows : []) as unknown as readonly Row[],
          rowCount: typeof info?.affectedRows === 'number' ? info.affectedRows : 0
        }
      }
      return {
        query: run,
        execute:
          connection.execute === undefined
            ? run
            : async <Row>(sql: string, values?: readonly unknown[]) => {
                const output = await connection.execute!(sql, values)
                return isQueryResult<Row>(output) ? output : run<Row>(sql, values)
              },
        beginTransaction: () => connection.beginTransaction(),
        commit: () => connection.commit(),
        rollback: () => connection.rollback(),
        release: () => connection.release()
      }
    }
  }
  if (pool.end !== undefined) adapter.end = () => pool.end!()
  return adapter
}

const isQueryResult = <Row>(value: unknown): value is QueryResult<Row> =>
  typeof value === 'object' && value !== null && 'rows' in value && 'rowCount' in value
