// oxlint-disable anti-slop/no-runtime-typeof -- migration option validation is a public boundary.
// oxlint-disable anti-slop/no-reflect-get -- MySQL driver errors have an untyped vendor shape.
// oxlint-disable anti-slop/no-unknown-returns -- driver error fields are narrowed by their callers.

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
const bootstrapInitialSql = (sql: string): string =>
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
const errorField = (cause: unknown, field: 'code' | 'errno'): unknown =>
  typeof cause === 'object' && cause !== null ? Reflect.get(cause, field) : undefined
const isKeyTooLong = (cause: unknown): boolean =>
  errorField(cause, 'code') === 'ER_TOO_LONG_KEY' || errorField(cause, 'errno') === 1071
type MigrationDdl = {
  readonly sql: string
  readonly isSatisfied: (connection: PoolConnection) => Promise<boolean>
}
type Column = {
  readonly column_name: string
  readonly data_type: string
  readonly character_maximum_length: number | null
  readonly is_nullable: 'YES' | 'NO'
  readonly extra: string
  readonly generation_expression: string
}
type Index = {
  readonly index_name: string
  readonly non_unique: number
  readonly seq_in_index: number
  readonly column_name: string
  readonly sub_part: number | null
  readonly collation: 'A' | 'D' | null
}
type IndexPart = Omit<Index, 'index_name' | 'seq_in_index'>

const column = async (
  connection: PoolConnection,
  table: string,
  name: string
): Promise<Column | undefined> => {
  const result = await connection.query<Column>(
    'SELECT column_name AS column_name, data_type AS data_type, character_maximum_length AS character_maximum_length, is_nullable AS is_nullable, extra AS extra, generation_expression AS generation_expression FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, name]
  )
  return result.rows[0]
}
const indexes = async (
  connection: PoolConnection,
  table: string,
  names: readonly string[]
): Promise<readonly Index[]> => {
  const result = await connection.query<Index>(
    `SELECT index_name AS index_name, non_unique AS non_unique, seq_in_index AS seq_in_index, column_name AS column_name, sub_part AS sub_part, collation AS collation FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name IN (${names.map(() => '?').join(',')}) ORDER BY index_name, seq_in_index`,
    [table, ...names]
  )
  return result.rows
}
const matchesIndexes = (
  actual: readonly Index[],
  expected: Readonly<Record<string, readonly IndexPart[]>>
): boolean => {
  const expectedRows = Object.entries(expected)
    .flatMap(([index_name, parts]) =>
      parts.map((part, offset) => ({ ...part, index_name, seq_in_index: offset + 1 }))
    )
    .sort(
      (left, right) =>
        left.index_name.localeCompare(right.index_name) || left.seq_in_index - right.seq_in_index
    )
  return (
    actual.length === expectedRows.length &&
    actual.every((row, index) => {
      const wanted = expectedRows[index]
      return (
        wanted !== undefined &&
        row.index_name === wanted.index_name &&
        Number(row.non_unique) === wanted.non_unique &&
        Number(row.seq_in_index) === wanted.seq_in_index &&
        row.column_name === wanted.column_name &&
        (row.sub_part === null ? null : Number(row.sub_part)) === wanted.sub_part &&
        row.collation === wanted.collation
      )
    })
  )
}
const compatibilityIndexes = Object.freeze({
  better_effect_mq_jobs_idempotency_idx: [
    { non_unique: 0, column_name: 'namespace', sub_part: null, collation: 'A' },
    { non_unique: 0, column_name: 'dedupe_hash', sub_part: null, collation: 'A' }
  ],
  better_effect_mq_jobs_claim_idx: [
    { non_unique: 1, column_name: 'namespace', sub_part: 191, collation: 'A' },
    { non_unique: 1, column_name: 'queue', sub_part: 191, collation: 'A' },
    { non_unique: 1, column_name: 'state', sub_part: null, collation: 'A' },
    { non_unique: 1, column_name: 'priority', sub_part: null, collation: 'D' },
    { non_unique: 1, column_name: 'run_at_ms', sub_part: null, collation: 'A' },
    { non_unique: 1, column_name: 'sequence', sub_part: null, collation: 'A' },
    { non_unique: 1, column_name: 'id', sub_part: 191, collation: 'A' }
  ],
  better_effect_mq_jobs_identity_idx: [
    { non_unique: 1, column_name: 'namespace', sub_part: 191, collation: 'A' },
    { non_unique: 1, column_name: 'queue', sub_part: 191, collation: 'A' },
    { non_unique: 1, column_name: 'name', sub_part: 191, collation: 'A' },
    { non_unique: 1, column_name: 'version', sub_part: null, collation: 'A' },
    { non_unique: 1, column_name: 'state', sub_part: null, collation: 'A' }
  ],
  better_effect_mq_jobs_recent_idx: [
    { non_unique: 1, column_name: 'namespace', sub_part: 191, collation: 'A' },
    { non_unique: 1, column_name: 'created_at_ms', sub_part: null, collation: 'D' },
    { non_unique: 1, column_name: 'sequence', sub_part: null, collation: 'D' },
    { non_unique: 1, column_name: 'id', sub_part: 191, collation: 'D' }
  ],
  better_effect_mq_jobs_run_at_idx: [
    { non_unique: 1, column_name: 'namespace', sub_part: 191, collation: 'A' },
    { non_unique: 1, column_name: 'queue', sub_part: 191, collation: 'A' },
    { non_unique: 1, column_name: 'state', sub_part: null, collation: 'A' },
    { non_unique: 1, column_name: 'run_at_ms', sub_part: null, collation: 'A' },
    { non_unique: 1, column_name: 'sequence', sub_part: null, collation: 'A' },
    { non_unique: 1, column_name: 'id', sub_part: 191, collation: 'A' }
  ],
  better_effect_mq_jobs_terminal_idx: [
    { non_unique: 1, column_name: 'namespace', sub_part: 191, collation: 'A' },
    { non_unique: 1, column_name: 'state', sub_part: null, collation: 'A' },
    { non_unique: 1, column_name: 'finished_at_ms', sub_part: null, collation: 'D' },
    { non_unique: 1, column_name: 'sequence', sub_part: null, collation: 'D' },
    { non_unique: 1, column_name: 'id', sub_part: 191, collation: 'D' }
  ]
} satisfies Readonly<Record<string, readonly IndexPart[]>>)
const migrationDdls = (migration: MySqlMigration): readonly MigrationDdl[] => {
  const ddl = statements(migration.sql)
  if (migration.version !== 2) return ddl.map((sql) => ({ sql, isSatisfied: async () => false }))
  if (ddl.length !== 4)
    throw new MySqlMigrationError(
      'MySQL migration 002 reconciliation metadata does not match its DDL'
    )
  return [
    {
      sql: ddl[0]!,
      isSatisfied: async (connection) => {
        const existing = await column(connection, MYSQL_TABLES.jobs, 'dedupe_hash')
        if (existing === undefined) return false
        const expression = existing.generation_expression.toLowerCase()
        if (
          existing.data_type.toLowerCase() === 'binary' &&
          Number(existing.character_maximum_length) === 32 &&
          existing.extra.toLowerCase().includes('stored generated') &&
          expression.includes('sha2') &&
          expression.includes('dedupe_key')
        )
          return true
        throw new MySqlMigrationError(
          'existing dedupe_hash column is incompatible with migration 002'
        )
      }
    },
    {
      sql: ddl[1]!,
      isSatisfied: async (connection) => {
        const existing = await column(connection, MYSQL_TABLES.jobs, 'last_settlement_outcome')
        return existing?.data_type.toLowerCase() === 'longtext' && existing.is_nullable === 'YES'
      }
    },
    {
      sql: ddl[2]!,
      isSatisfied: async (connection) =>
        matchesIndexes(
          await indexes(connection, MYSQL_TABLES.jobs, Object.keys(compatibilityIndexes)),
          compatibilityIndexes
        )
    },
    {
      sql: ddl[3]!,
      isSatisfied: async (connection) =>
        matchesIndexes(
          await indexes(connection, MYSQL_TABLES.attempts, [
            'better_effect_mq_attempts_sequence_idx'
          ]),
          {
            better_effect_mq_attempts_sequence_idx: [
              { non_unique: 1, column_name: 'ledger_sequence', sub_part: null, collation: 'A' }
            ]
          }
        )
    }
  ]
}
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
          const migrationStatements = migrationDdls(migration)
          try {
            for (const statement of migrationStatements) {
              if (await statement.isSatisfied(connection)) continue
              await connection.query(statement.sql)
            }
          } catch (cause) {
            // The published v1 layout has composite utf8mb4 indexes wider than
            // InnoDB's 3072-byte limit. Keep its bytes/checksum immutable and,
            // only for a brand-new unrecorded install, bootstrap the equivalent
            // v1 table layout with safe index prefixes before applying v2.
            if (start !== 0 || migration.version !== 1 || !isKeyTooLong(cause)) throw cause
            for (const statement of statements(bootstrapInitialSql(migration.sql)))
              await connection.query(statement)
          }
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
