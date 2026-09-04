// oxlint-disable anti-slop/no-runtime-typeof -- SQLite catalog rows are narrowed at the schema boundary.
// oxlint-disable anti-slop/no-known-value-widening -- migration result is a fixed public contract.
import { createHash } from 'node:crypto'
import type { SqliteDatabase } from './config'
import { SqliteMigrationError, SqliteSchemaValidationError } from './errors'
import { MIGRATION_COMPONENT, SQLITE_TABLES, migrationSql } from './schema'

const checksum = createHash('sha256').update(migrationSql, 'utf8').digest('hex')

export interface SqliteMigrationOptions {
  readonly database: SqliteDatabase
  readonly appliedAtMs?: number
}

export interface SqliteMigrationResult {
  readonly component: typeof MIGRATION_COMPONENT
  readonly version: 1
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
      if (existing != null && (existing.version !== 1 || existing.checksum !== checksum)) {
        throw new SqliteMigrationError('migration checksum mismatch')
      }
      if (existing == null) {
        database
          .prepare(
            `INSERT INTO ${SQLITE_TABLES.schemaVersions}(component, version, applied_at_ms, checksum) VALUES(?, ?, ?, ?)`
          )
          .run(MIGRATION_COMPONENT, 1, appliedAtMs, checksum)
      }
      database.exec('COMMIT')
      return { component: MIGRATION_COMPONENT, version: 1, applied: existing == null ? [1] : [] }
    } catch (cause) {
      rollback(database)
      if (cause instanceof SqliteMigrationError) throw cause
      throw new SqliteMigrationError('SQLite migration failed', { cause })
    }
  },

  validate(database: SqliteDatabase): { readonly version: 1 } {
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
      const row = database
        .prepare(
          `SELECT version, checksum FROM ${SQLITE_TABLES.schemaVersions} WHERE component = ?`
        )
        .get(MIGRATION_COMPONENT)
      if (row == null || row.version !== 1 || row.checksum !== checksum) {
        throw new SqliteSchemaValidationError(
          'schema is not migrated to the supported SQLite layout'
        )
      }
      return { version: 1 }
    } catch (cause) {
      if (cause instanceof SqliteSchemaValidationError) throw cause
      throw new SqliteSchemaValidationError('SQLite schema validation failed')
    }
  }
}

/** Explicit migration API; startup validation never changes the layout. */
export const migrate = (options: SqliteMigrationOptions): SqliteMigrationResult =>
  SqliteMigrator.migrate(options)
