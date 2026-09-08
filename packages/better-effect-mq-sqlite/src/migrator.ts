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
  outboxMigrationSql,
  flowMigrationSql,
  controlsMigrationSql,
  eventsMigrationSql
} from './schema'

const initialChecksum = createHash('sha256').update(migrationSql, 'utf8').digest('hex')
const scheduleChecksum = createHash('sha256').update(scheduleMigrationSql, 'utf8').digest('hex')
const outboxChecksum = createHash('sha256').update(outboxMigrationSql, 'utf8').digest('hex')
const versionTwoChecksum = createHash('sha256')
  .update(`1:${initialChecksum}\n2:${scheduleChecksum}\n`, 'utf8')
  .digest('hex')
const versionThreeChecksum = createHash('sha256')
  .update(`1:${initialChecksum}\n2:${scheduleChecksum}\n3:${outboxChecksum}\n`, 'utf8')
  .digest('hex')
const flowChecksum = createHash('sha256').update(flowMigrationSql, 'utf8').digest('hex')
const checksum = createHash('sha256')
  .update(
    `1:${initialChecksum}\n2:${scheduleChecksum}\n3:${outboxChecksum}\n4:${flowChecksum}\n`,
    'utf8'
  )
  .digest('hex')
const controlsChecksum = createHash('sha256').update(controlsMigrationSql, 'utf8').digest('hex')
const versionFiveChecksum = createHash('sha256')
  .update(
    `1:${initialChecksum}\n2:${scheduleChecksum}\n3:${outboxChecksum}\n4:${flowChecksum}\n5:${controlsChecksum}\n`,
    'utf8'
  )
  .digest('hex')
const eventsChecksum = createHash('sha256').update(eventsMigrationSql, 'utf8').digest('hex')
const versionSixChecksum = createHash('sha256')
  .update(
    `1:${initialChecksum}\n2:${scheduleChecksum}\n3:${outboxChecksum}\n4:${flowChecksum}\n5:${controlsChecksum}\n6:${eventsChecksum}\n`,
    'utf8'
  )
  .digest('hex')

export interface SqliteMigrationOptions {
  readonly database: SqliteDatabase
  readonly appliedAtMs?: number
}

export interface SqliteMigrationResult {
  readonly component: typeof MIGRATION_COMPONENT
  readonly version: 6
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
    const foreignKeys = database.prepare('PRAGMA foreign_keys').get()
    const restoreForeignKeys = Number(foreignKeys?.foreign_keys) === 1
    try {
      if (restoreForeignKeys) database.exec('PRAGMA foreign_keys = OFF')
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
          if (existing.checksum !== versionThreeChecksum) {
            throw new SqliteMigrationError('migration checksum mismatch')
          }
        } else if (version === 4) {
          if (existing.checksum !== checksum)
            throw new SqliteMigrationError('migration checksum mismatch')
        } else if (version === 5) {
          if (existing.checksum !== versionFiveChecksum)
            throw new SqliteMigrationError('migration checksum mismatch')
        } else if (version === 6) {
          if (existing.checksum !== versionSixChecksum)
            throw new SqliteMigrationError('migration checksum mismatch')
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
      let currentVersion = existing == null ? 0 : Number(existing.version)
      if (currentVersion < 2) {
        database.exec(scheduleMigrationSql)
        database
          .prepare(
            `UPDATE ${SQLITE_TABLES.schemaVersions} SET version = ?, applied_at_ms = ?, checksum = ? WHERE component = ?`
          )
          .run(2, appliedAtMs, versionTwoChecksum, MIGRATION_COMPONENT)
        applied.push(2)
        currentVersion = 2
      }
      if (currentVersion < 3) {
        database.exec(outboxMigrationSql)
        database
          .prepare(
            `UPDATE ${SQLITE_TABLES.schemaVersions} SET version = ?, applied_at_ms = ?, checksum = ? WHERE component = ?`
          )
          .run(3, appliedAtMs, versionThreeChecksum, MIGRATION_COMPONENT)
        applied.push(3)
        currentVersion = 3
      }
      if (currentVersion < 4) {
        database.exec(flowMigrationSql)
        database
          .prepare(
            `UPDATE ${SQLITE_TABLES.schemaVersions} SET version = ?, applied_at_ms = ?, checksum = ? WHERE component = ?`
          )
          .run(4, appliedAtMs, checksum, MIGRATION_COMPONENT)
        applied.push(4)
        currentVersion = 4
      }
      if (currentVersion < 5) {
        database.exec(controlsMigrationSql)
        database
          .prepare(
            `UPDATE ${SQLITE_TABLES.schemaVersions} SET version = ?, applied_at_ms = ?, checksum = ? WHERE component = ?`
          )
          .run(5, appliedAtMs, versionFiveChecksum, MIGRATION_COMPONENT)
        applied.push(5)
        currentVersion = 5
      }
      if (currentVersion < 6) {
        database.exec(eventsMigrationSql)
        database
          .prepare(
            `UPDATE ${SQLITE_TABLES.schemaVersions} SET version = ?, applied_at_ms = ?, checksum = ? WHERE component = ?`
          )
          .run(6, appliedAtMs, versionSixChecksum, MIGRATION_COMPONENT)
        applied.push(6)
      }
      database.exec('COMMIT')
      return { component: MIGRATION_COMPONENT, version: 6, applied }
    } catch (cause) {
      rollback(database)
      if (cause instanceof SqliteMigrationError) throw cause
      throw new SqliteMigrationError('SQLite migration failed', { cause })
    } finally {
      if (restoreForeignKeys) database.exec('PRAGMA foreign_keys = ON')
    }
  },

  validate(database: SqliteDatabase): { readonly version: 3 | 4 | 5 | 6 } {
    try {
      const names = new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .flatMap((row) => (typeof row?.name === 'string' ? [row.name] : []))
      )
      for (const table of Object.values(SQLITE_TABLES).slice(0, 7)) {
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
      const row = database
        .prepare(
          `SELECT version, checksum FROM ${SQLITE_TABLES.schemaVersions} WHERE component = ?`
        )
        .get(MIGRATION_COMPONENT)
      if (
        row == null ||
        (Number(row.version) !== 3 &&
          Number(row.version) !== 4 &&
          Number(row.version) !== 5 &&
          Number(row.version) !== 6)
      ) {
        throw new SqliteSchemaValidationError(
          'schema is not migrated to the supported SQLite layout'
        )
      }
      const numericVersion = Number(row.version)
      const version =
        numericVersion === 3 ? 3 : numericVersion === 4 ? 4 : numericVersion === 5 ? 5 : 6
      const expectedChecksum =
        version === 3
          ? versionThreeChecksum
          : version === 4
            ? checksum
            : version === 5
              ? versionFiveChecksum
              : versionSixChecksum
      if (row.checksum !== expectedChecksum) {
        throw new SqliteSchemaValidationError('schema migration checksum mismatch')
      }
      const indexesToCheck =
        version === 3
          ? SQLITE_INDEXES.filter(
              (index) =>
                !index.includes('flow_') &&
                index !== 'better_effect_mq_jobs_waiting_children_idx' &&
                !index.includes('controlled_permits') &&
                !index.includes('rate_windows') &&
                !index.includes('jobs_dispatch') &&
                !index.includes('job_events')
            )
          : version === 4
            ? SQLITE_INDEXES.filter(
                (index) =>
                  !index.includes('better_effect_mq_jobs_dispatch') &&
                  !index.includes('controlled_permits') &&
                  !index.includes('rate_windows') &&
                  !index.includes('job_events')
              )
            : version === 5
              ? SQLITE_INDEXES.filter((index) => !index.includes('job_events'))
              : SQLITE_INDEXES
      for (const index of indexesToCheck) {
        if (!indexes.has(index)) throw new SqliteSchemaValidationError(`missing index ${index}`)
      }
      if (version >= 4) {
        for (const table of [SQLITE_TABLES.flowChildren, SQLITE_TABLES.flowOutbox]) {
          if (!names.has(table)) throw new SqliteSchemaValidationError(`missing table ${table}`)
        }
        const flowColumns = new Set(
          database
            .prepare(`PRAGMA table_info(${SQLITE_TABLES.jobs})`)
            .all()
            .flatMap((item) => (typeof item?.name === 'string' ? [item.name] : []))
        )
        for (const column of [
          'parent',
          'flow',
          'flow_manifest_digest',
          'flow_lease_token',
          'flow_name',
          'flow_parent_store_key',
          'flow_depth'
        ]) {
          if (!flowColumns.has(column))
            throw new SqliteSchemaValidationError(`missing column ${SQLITE_TABLES.jobs}.${column}`)
        }
      }
      if (version === 5) {
        const jobColumns = new Set(
          database
            .prepare(`PRAGMA table_info(${SQLITE_TABLES.jobs})`)
            .all()
            .flatMap((item) => (typeof item?.name === 'string' ? [item.name] : []))
        )
        if (!jobColumns.has('dispatch_key'))
          throw new SqliteSchemaValidationError(`missing column ${SQLITE_TABLES.jobs}.dispatch_key`)
        const requiredControlTables = [
          SQLITE_TABLES.controls,
          SQLITE_TABLES.controlCursors,
          SQLITE_TABLES.permits,
          SQLITE_TABLES.rateWindows
        ]
        for (const table of requiredControlTables) {
          if (!names.has(table)) throw new SqliteSchemaValidationError(`missing table ${table}`)
        }
      }
      if (version === 6) {
        for (const table of [SQLITE_TABLES.eventCursors, SQLITE_TABLES.events]) {
          if (!names.has(table)) throw new SqliteSchemaValidationError(`missing table ${table}`)
        }
        for (const index of [
          'better_effect_mq_job_events_queue_cursor_idx',
          'better_effect_mq_job_events_type_cursor_idx'
        ]) {
          if (!indexes.has(index)) throw new SqliteSchemaValidationError(`missing index ${index}`)
        }
      }
      return { version }
    } catch (cause) {
      if (cause instanceof SqliteSchemaValidationError) throw cause
      throw new SqliteSchemaValidationError('SQLite schema validation failed')
    }
  }
}

/** Explicit migration API; startup validation never changes the layout. */
export const migrate = (options: SqliteMigrationOptions): SqliteMigrationResult =>
  SqliteMigrator.migrate(options)
