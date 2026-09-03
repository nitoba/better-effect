// oxlint-disable anti-slop/no-runtime-typeof -- optional driver configuration is validated at the boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- pg accepts an open driver option object.
// oxlint-disable anti-slop/no-unknown-parameters -- optional driver configuration is validated at the boundary.

import { Service } from 'better-effect'

import {
  normalizePostgresJobStoreConfig,
  normalizePostgresJobStoreConnectionConfig,
  type Pool,
  type PostgresJobStoreConfig,
  type PostgresJobStoreConnectionConfig
} from './config'
import { PostgresConfigurationError, redactedPostgresError } from './errors'
import type {
  PostgresMigrationOptions,
  PostgresMigrationResult,
  PostgresSchemaValidationResult
} from './migrator'

export class PostgresClient extends Service<PostgresClient>()('PostgresClient') {
  readonly pool: Pool
  readonly namespace: string
  readonly schema: string
  readonly ownsPool: boolean
  readonly validateSchema: boolean

  private disposal: Promise<void> | undefined

  constructor(
    pool: Pool,
    config: Pick<PostgresJobStoreConfig, 'namespace' | 'schema' | 'validateSchema'>,
    ownsPool: boolean
  ) {
    super()
    const normalized = normalizePostgresJobStoreConfig({ ...config, pool })
    this.pool = normalized.pool
    this.namespace = normalized.namespace
    this.schema = normalized.schema
    this.validateSchema = normalized.validateSchema
    this.ownsPool = ownsPool
  }

  static fromPool(config: PostgresJobStoreConfig): PostgresClient
  static fromPool(pool: Pool, options?: Omit<PostgresJobStoreConfig, 'pool'>): PostgresClient
  static fromPool(
    configOrPool: PostgresJobStoreConfig | Pool,
    options: Omit<PostgresJobStoreConfig, 'pool'> = {}
  ): PostgresClient {
    if (isPoolConfig(configOrPool)) {
      const normalized = normalizePostgresJobStoreConfig(configOrPool)
      return new PostgresClient(normalized.pool, normalized, false)
    }
    const normalized = normalizePostgresJobStoreConfig({ ...options, pool: configOrPool })
    return new PostgresClient(normalized.pool, normalized, false)
  }

  /** The optional `pg` peer is loaded only when a connection-backed client is requested. */
  static async fromConfig(config: PostgresJobStoreConnectionConfig): Promise<PostgresClient> {
    const normalized = normalizePostgresJobStoreConnectionConfig(config)
    try {
      const { Pool: PoolConstructor } = await import('pg')
      const poolOptions = Object.assign(
        {},
        normalized.poolConfig,
        normalized.connectionString === undefined
          ? {}
          : { connectionString: normalized.connectionString }
      )
      const pool = new PoolConstructor(poolOptions)
      return new PostgresClient(
        pool,
        {
          namespace: normalized.namespace,
          schema: normalized.schema,
          validateSchema: normalized.validateSchema
        },
        true
      )
    } catch (cause) {
      if (cause instanceof PostgresConfigurationError) throw cause
      throw redactedPostgresError('client configuration', cause)
    }
  }

  async migrate(options?: PostgresMigrationOptions): Promise<PostgresMigrationResult> {
    const { PostgresMigrator } = await import('./migrator')
    return PostgresMigrator.run(this, options)
  }

  async validate(): Promise<PostgresSchemaValidationResult> {
    const { PostgresMigrator } = await import('./migrator')
    return PostgresMigrator.validate(this)
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposal = this.disposePool()
    return this.disposal
  }

  async close(): Promise<void> {
    return this.dispose()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }

  private async disposePool(): Promise<void> {
    if (!this.ownsPool) return
    try {
      if (this.pool.end === undefined) return
      await this.pool.end()
    } catch (cause) {
      throw redactedPostgresError('pool shutdown', cause)
    }
  }
}

const isPoolConfig = (value: PostgresJobStoreConfig | Pool): value is PostgresJobStoreConfig => {
  if (value === null || typeof value !== 'object') return false
  try {
    return Object.prototype.hasOwnProperty.call(value, 'pool')
  } catch {
    return false
  }
}
