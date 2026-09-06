// oxlint-disable anti-slop/no-runtime-typeof -- SQLite catalog rows are narrowed at the schema boundary.
// oxlint-disable anti-slop/no-known-value-widening -- migration result is a fixed public contract.
import { createHash } from 'node:crypto'
import type { SqliteDatabase } from './config'
import { SqliteMigrationError, SqliteSchemaValidationError } from './errors'
import {
  MIGRATION_COMPONENT,
  SQLITE_INDEXES,
  SQLITE_TABLES,
  migrationSql,
  scheduleMigrationSql,
  outboxMigrationSql
} from './schema'

const initialChecksum = createHash('sha256').update(migrationSql, 'utf8').digest('hex')
const scheduleChecksum = createHash('sha256').update(scheduleMigrationSql, 'utf8').digest('hex')
const outboxChecksum = createHash('sha256').update(outboxMigrationSql, 'utf8').digest('hex')
const versionTwoChecksum = createHash('sha256')
  .update(`1:${initialChecksum}\n2:${scheduleChecksum}\n`, 'utf8')
  .digest('hex')
const checksum = createHash('sha256')
  .update(`1:${initialChecksum}\n2:${scheduleChecksum}\n3:${outboxChecksum}\n`, 'utf8')
  .digest('hex')

export interface SqliteMigrationOptions {
  readonly database: SqliteDatabase
  readonly appliedAtMs?: number
}

export interface SqliteMigrationResult {
  readonly component: typeof MIGRATION_COMPONENT
  readonly version: 3
  readonly applied: readonly number[]
}

const begin = (database: SqliteDatabase): void => database.exec('BEGIN IMMEDIATE')
const rollback = (database: SqliteDatabase): void => {
  try {
    database.exec('ROLLBACK')
  } catch {
    /* preserve the migration error */
  }
}

export const SqliteMigrator = {
  migrate(options: SqliteMigrationOptions): SqliteMigrationResult {
    const { database } = options
    const appliedAtMs = options.appliedAtMs ?? Date.now()
    if (!Number.isSafeInteger(appliedAtMs) || appliedAtMs < 0) {
      throw new SqliteMigrationError('appliedAtMs must be a non-negative safe integer')
    }
    try {
      begin(database)
      database.exec(migrationSql)
      const existing = database
        .prepare(
          `SELECT version, checksum FROM ${SQLITE_TABLES.schemaVersions} WHERE component = ?`
        )
        .get(MIGRATION_COMPONENT)
      const applied: number[] = []
      if (existing != null) {
        const version = Number(existing.version)
        if (version === 1) {
          if (existing.checksum !== initialChecksum) {
            throw new SqliteMigrationError('migration checksum mismatch')
          }
        } else if (version === 2) {
          if (existing.checksum !== versionTwoChecksum) {
            throw new SqliteMigrationError('migration checksum mismatch')
          }
        } else if (version === 3) {
          if (existing.checksum !== checksum) {
            throw new SqliteMigrationError('migration checksum mismatch')
          }
        } else {
          throw new SqliteMigrationError('unsupported SQLite migration version')
        }
      } else {
        database
          .prepare(
            `INSERT INTO ${SQLITE_TABLES.schemaVersions}(component, version, applied_at_ms, checksum) VALUES(?, ?, ?, ?)`
          )
          .run(MIGRATION_COMPONENT, 1, appliedAtMs, initialChecksum)
        applied.push(1)
      }
      if (existing == null || Number(existing.version) === 1) {
        database.exec(scheduleMigrationSql)
        database
          .prepare(
            `UPDATE ${SQLITE_TABLES.schemaVersions} SET version = ?, applied_at_ms = ?, checksum = ? WHERE component = ?`
          )
          .run(2, appliedAtMs, checksum, MIGRATION_COMPONENT)
        applied.push(2)
      }
      if (existing == null || Number(existing.version) < 3) {
        database.exec(outboxMigrationSql)
        database
          .prepare(
            `UPDATE ${SQLITE_TABLES.schemaVersions} SET version = ?, applied_at_ms = ?, checksum = ? WHERE component = ?`
          )
          .run(3, appliedAtMs, checksum, MIGRATION_COMPONENT)
        applied.push(3)
      }
      database.exec('COMMIT')
      return { component: MIGRATION_COMPONENT, version: 3, applied }
    } catch (cause) {
      rollback(database)
      if (cause instanceof SqliteMigrationError) throw cause
      throw new SqliteMigrationError('SQLite migration failed', { cause })
    }
  },

  validate(database: SqliteDatabase): { readonly version: 3 } {
    try {
      const names = new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .flatMap((row) => (typeof row?.name === 'string' ? [row.name] : []))
      )
      for (const table of Object.values(SQLITE_TABLES)) {
        if (!names.has(table)) throw new SqliteSchemaValidationError(`missing table ${table}`)
      }
      const requiredColumns: Readonly<Record<string, readonly string[]>> = {
        [SQLITE_TABLES.schedules]: [
          'namespace',
          'schedule_key',
          'schedule_group',
          'job_queue',
          'job_name',
          'job_version',
          'queue',
          'cron',
          'every_ms',
          'time_zone',
          'payload',
          'metadata',
          'priority',
          'attempts_max',
          'backoff',
          'timeout_ms',
          'misfire',
          'overlap',
          'paused',
          'revision',
          'next_run_at_ms',
          'last_scheduled_at_ms',
          'last_job_id',
          'created_at_ms',
          'updated_at_ms'
        ],
        [SQLITE_TABLES.outbox]: [
          'row_sequence',
          'namespace',
          'id',
          'target',
          'state',
          'protocol_version',
          'request_json',
          'request_digest',
          'attempts_max',
          'attempts_made',
          'run_at_ms',
          'created_at_ms',
          'updated_at_ms',
          'published_at_ms',
          'lease_owner',
          'lease_token',
          'lease_expires_at_ms',
          'failure',
          'ordering_sequence'
        ]
      }
      for (const [table, columns] of Object.entries(requiredColumns)) {
        const actual = new Set(
          database
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .flatMap((row) => (typeof row?.name === 'string' ? [row.name] : []))
        )
        for (const column of columns) {
          if (!actual.has(column))
            throw new SqliteSchemaValidationError(`missing column ${table}.${column}`)
        }
      }
      const indexes = new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all()
          .flatMap((row) => (typeof row?.name === 'string' ? [row.name] : []))
      )
      for (const index of SQLITE_INDEXES) {
        if (!indexes.has(index)) throw new SqliteSchemaValidationError(`missing index ${index}`)
      }
      const row = database
        .prepare(
          `SELECT version, checksum FROM ${SQLITE_TABLES.schemaVersions} WHERE component = ?`
        )
        .get(MIGRATION_COMPONENT)
      if (row == null || Number(row.version) !== 3 || row.checksum !== checksum) {
        throw new SqliteSchemaValidationError(
          'schema is not migrated to the supported SQLite layout'
        )
      }
      return { version: 3 }
    } catch (cause) {
      if (cause instanceof SqliteSchemaValidationError) throw cause
      throw new SqliteSchemaValidationError('SQLite schema validation failed')
    }
  }
}

/** Explicit migration API; startup validation never changes the layout. */
export const migrate = (options: SqliteMigrationOptions): SqliteMigrationResult =>
  SqliteMigrator.migrate(options)
