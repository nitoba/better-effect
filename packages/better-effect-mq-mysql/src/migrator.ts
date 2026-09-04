// oxlint-disable anti-slop/no-runtime-typeof -- migration option validation is a public boundary.

import { createHash } from 'node:crypto'
import { MySqlClient } from './client'
import type { Pool, PoolConnection } from './config'
import {
  MySqlConfigurationError,
  MySqlMigrationError,
  MySqlSchemaValidationError,
  redactedMySqlError
} from './errors'
import {
  MIGRATION_COMPONENT,
  MYSQL_TABLES,
  loadMySqlMigrations,
  migrationManifestChecksum,
  type MySqlMigration
} from './schema'

export interface MySqlMigrationOptions {
  readonly component?: string
  readonly appliedAtMs?: number
}
export interface MySqlMigrationResult {
  readonly component: string
  readonly version: number
  readonly applied: readonly number[]
}
export interface MySqlSchemaValidationResult {
  readonly component: string
  readonly version: number
}

const lockName = (database: string | undefined): string =>
  `better-effect-mq:${createHash('sha256')
    .update(database ?? 'default')
    .digest('hex')
    .slice(0, 47)}`
const componentOf = (component: string | undefined): string => {
  const value = component ?? MIGRATION_COMPONENT
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000'))
    throw new MySqlConfigurationError(
      'component must be a non-empty string without NUL',
      'component'
    )
  return value
}
const appliedAt = (value: number | undefined): number => {
  const now = value ?? Date.now()
  if (!Number.isSafeInteger(now) || now < 0)
    throw new MySqlConfigurationError(
      'appliedAtMs must be a non-negative safe integer',
      'appliedAtMs'
    )
  return now
}
const acquire = async (pool: {
  getConnection(): PromiseLike<PoolConnection>
}): Promise<PoolConnection> => {
  try {
    return await pool.getConnection()
  } catch (cause) {
    throw redactedMySqlError('connection acquisition', cause)
  }
}
const databaseName = async (connection: PoolConnection): Promise<string | undefined> => {
  const result = await connection.query<{ database_name: string | null }>(
    'SELECT DATABASE() AS database_name'
  )
  return result.rows[0]?.database_name ?? undefined
}
const statements = (sql: string): readonly string[] =>
  sql
    // Shipped migrations contain ordinary DDL only; splitting avoids requiring
    // mysql2's unsafe multiStatements option for a migration connection.
    .split(/;\s*(?:\r?\n|$)/u)
    .map((statement) => statement.trim())
    .filter(Boolean)
const versionOf = (
  row: { version: number | string; checksum: string } | undefined,
  migrations: readonly MySqlMigration[],
  component: string
): number => {
  if (row === undefined) return 0
  const version = Number(row.version)
  const latest = migrations.at(-1)?.version ?? 0
  if (!Number.isSafeInteger(version) || version < 0 || version > latest)
    throw new MySqlMigrationError(
      `migration version for ${component} is outside the supported range`
    )
  if (version > 0 && row.checksum !== migrationManifestChecksum(migrations, version))
    throw new MySqlMigrationError(
      `migration checksum mismatch for ${component} at version ${version}`
    )
  return version
}

export const MySqlMigrator = Object.freeze({
  async run(
    poolOrClient: Pool | MySqlClient,
    options: MySqlMigrationOptions = {}
  ): Promise<MySqlMigrationResult> {
    const pool = (
      poolOrClient instanceof MySqlClient ? poolOrClient : MySqlClient.fromPool(poolOrClient)
    ).pool
    const component = componentOf(options.component)
    const now = appliedAt(options.appliedAtMs)
    const migrations = await loadMySqlMigrations()
    const connection = await acquire(pool)
    try {
      const database = await databaseName(connection)
      const lock = lockName(database)
      const acquiredLock = await connection.query<{ acquired: number }>(
        'SELECT GET_LOCK(?, 60) AS acquired',
        [lock]
      )
      if (Number(acquiredLock.rows[0]?.acquired) !== 1)
        throw new MySqlMigrationError('could not acquire MySQL migration lock')
      try {
        await connection.query(
          `CREATE TABLE IF NOT EXISTS ${MYSQL_TABLES.schemaVersions} (component VARCHAR(255) NOT NULL PRIMARY KEY, version INT NOT NULL, applied_at_ms BIGINT NOT NULL, checksum CHAR(64) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'applied', CHECK (component <> '' AND version >= 0 AND checksum <> '')) ENGINE=InnoDB`
        )
        const current = await connection.query<{ version: number | string; checksum: string }>(
          `SELECT version, checksum FROM ${MYSQL_TABLES.schemaVersions} WHERE component = ?`,
          [component]
        )
        const start = versionOf(current.rows[0], migrations, component)
        const applied: number[] = []
        for (const migration of migrations) {
          if (migration.version <= start) continue
          // MySQL DDL commits implicitly. Record only after every statement succeeds;
          // a crash leaves an unrecorded, idempotently re-runnable migration.
          for (const statement of statements(migration.sql)) await connection.query(statement)
          await connection.query(
            `INSERT INTO ${MYSQL_TABLES.schemaVersions} (component, version, applied_at_ms, checksum, status) VALUES (?, ?, ?, ?, 'applied') ON DUPLICATE KEY UPDATE version=VALUES(version), applied_at_ms=VALUES(applied_at_ms), checksum=VALUES(checksum), status='applied'`,
            [
              component,
              migration.version,
              now,
              migrationManifestChecksum(migrations, migration.version)
            ]
          )
          applied.push(migration.version)
        }
        await assertCompatible(connection, component, migrations)
        return {
          component,
          version: migrations.at(-1)?.version ?? 0,
          applied: Object.freeze(applied)
        }
      } finally {
        await Promise.resolve(connection.query('SELECT RELEASE_LOCK(?)', [lock])).catch(
          () => undefined
        )
      }
    } catch (cause) {
      throw cause instanceof MySqlMigrationError ? cause : redactedMySqlError('migration', cause)
    } finally {
      try {
        connection.release()
      } catch {
        /* preserve the migration outcome */
      }
    }
  },
  async validate(
    poolOrClient: Pool | MySqlClient,
    options: Pick<MySqlMigrationOptions, 'component'> = {}
  ): Promise<MySqlSchemaValidationResult> {
    const pool = (
      poolOrClient instanceof MySqlClient ? poolOrClient : MySqlClient.fromPool(poolOrClient)
    ).pool
    const component = componentOf(options.component)
    const migrations = await loadMySqlMigrations()
    const connection = await acquire(pool)
    try {
      await assertCompatible(connection, component, migrations)
      return { component, version: migrations.at(-1)?.version ?? 0 }
    } catch (cause) {
      if (cause instanceof MySqlSchemaValidationError) throw cause
      throw redactedMySqlError('schema validation', cause)
    } finally {
      connection.release()
    }
  }
})

export const assertMySqlCompatibility = async (connection: PoolConnection): Promise<void> => {
  const version = await connection.query<{ version: string; comment: string }>(
    'SELECT VERSION() AS version, @@version_comment AS comment'
  )
  const server = version.rows[0]
  const match = /^8\.(\d+)\.(\d+)/u.exec(server?.version ?? '')
  const minor = Number(match?.[1])
  const patch = Number(match?.[2])
  if (
    match === null ||
    (minor === 0 && patch < 16) ||
    (server?.comment ?? '').toLowerCase().includes('mariadb')
  )
    throw new MySqlSchemaValidationError(
      'MySQL 8.0.16+ with InnoDB is required; MariaDB is not supported'
    )
  const mode = await connection.query<{ sql_mode: string }>('SELECT @@sql_mode AS sql_mode')
  if (!mode.rows[0]?.sql_mode.includes('STRICT_TRANS_TABLES'))
    throw new MySqlSchemaValidationError('MySQL strict SQL mode (STRICT_TRANS_TABLES) is required')
}

const assertCompatible = async (
  connection: PoolConnection,
  component: string,
  migrations: readonly MySqlMigration[]
): Promise<void> => {
  await assertMySqlCompatibility(connection)
  const tables = Object.values(MYSQL_TABLES)
  const found = await connection.query<{ table_name: string; engine: string | null }>(
    `SELECT table_name AS table_name, engine AS engine FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (${tables.map(() => '?').join(',')})`,
    tables
  )
  const actual = new Map(found.rows.map((row) => [row.table_name, row.engine]))
  const problems = tables
    .filter((table) => actual.get(table)?.toLowerCase() !== 'innodb')
    .map((table) => (actual.has(table) ? `table ${table} is not InnoDB` : `missing table ${table}`))
  const row =
    problems.length === 0
      ? await connection.query<{ version: number | string; checksum: string }>(
          `SELECT version, checksum FROM ${MYSQL_TABLES.schemaVersions} WHERE component = ?`,
          [component]
        )
      : undefined
  if (problems.length === 0) {
    try {
      if (versionOf(row!.rows[0], migrations, component) !== (migrations.at(-1)?.version ?? 0))
        problems.push('schema is not migrated to the latest version')
    } catch (cause) {
      problems.push(cause instanceof Error ? cause.message : 'invalid migration metadata')
    }
  }
  if (problems.length > 0)
    throw new MySqlSchemaValidationError(
      `MySQL schema validation failed: ${problems.join('; ')}; run MySqlMigrator.run(pool)`,
      problems
    )
}

export type { PoolConnection as MySqlPoolConnection }
export type { MySqlMigration } from './schema'
