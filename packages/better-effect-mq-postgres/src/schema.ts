import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgresMigrationError } from './errors'
import { DEFAULT_SCHEMA, validateSchema } from './config'

export const MIGRATION_SCHEMA_PLACEHOLDER = '{{SCHEMA}}' as const
export const MIGRATION_COMPONENT = 'better-effect-mq' as const

export const POSTGRES_TABLES = {
  attempts: 'better_effect_mq_attempts',
  jobs: 'better_effect_mq_jobs',
  queues: 'better_effect_mq_queues',
  schemaVersions: 'better_effect_mq_schema_versions'
} as const

export const POSTGRES_INDEXES = [
  'better_effect_mq_jobs_claim_idx',
  'better_effect_mq_jobs_active_lease_idx',
  'better_effect_mq_jobs_identity_idx',
  'better_effect_mq_jobs_recent_idx',
  'better_effect_mq_jobs_run_at_idx',
  'better_effect_mq_jobs_terminal_idx',
  'better_effect_mq_jobs_metadata_idx',
  'better_effect_mq_jobs_idempotency_idx'
] as const

export interface PostgresMigration {
  readonly version: number
  readonly name: string
  readonly sql: string
  readonly checksum: string
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const migrationDirectories = (): readonly string[] => {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  return [join(moduleDirectory, '..', 'migrations'), join(moduleDirectory, 'migrations')]
}

const parseMigrationName = (filename: string): { version: number; name: string } | undefined => {
  const match = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.sql$/u.exec(filename)
  if (match === null) return undefined
  const version = Number(match[1])
  if (!Number.isSafeInteger(version) || version < 1) return undefined
  return { version, name: `${match[1]}_${match[2]}` }
}

const readMigrationFiles = async (): Promise<readonly string[]> => {
  for (const directory of migrationDirectories()) {
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      const files = entries
        .filter((entry) => entry.isFile() && parseMigrationName(entry.name) !== undefined)
        .map((entry) => entry.name)
        .sort(
          (left, right) =>
            (parseMigrationName(left)?.version ?? 0) - (parseMigrationName(right)?.version ?? 0)
        )
      if (files.length > 0) return files.map((file) => join(directory, file))
    } catch {
      // Source and packed distributions have different relative layouts.
    }
  }
  throw new PostgresMigrationError('PostgreSQL migrations are not included in this package')
}

const assertMigrationSequence = (migrations: readonly PostgresMigration[]): void => {
  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1
    if (migration.version !== expected) {
      throw new PostgresMigrationError(
        `PostgreSQL migrations must be contiguous starting at version 1 (expected ${expected})`,
        migration.name
      )
    }
  }
}

export const loadPostgresMigrations = async (): Promise<readonly PostgresMigration[]> => {
  const paths = await readMigrationFiles()
  const migrations: PostgresMigration[] = []
  for (const path of paths) {
    const filename = basename(path)
    const parsed = parseMigrationName(filename)
    if (parsed === undefined) continue
    const sql = await readFile(path, 'utf8')
    migrations.push({ ...parsed, sql, checksum: sha256(sql) })
  }
  assertMigrationSequence(migrations)
  return migrations
}

export const migrationManifestChecksum = (
  migrations: readonly PostgresMigration[],
  throughVersion = migrations.at(-1)?.version ?? 0
): string => {
  const selected = migrations.filter((migration) => migration.version <= throughVersion)
  if (selected.length === 1) return selected[0]?.checksum ?? sha256('')
  return sha256(selected.map(({ version, checksum }) => `${version}:${checksum}\n`).join(''))
}

export const quoteIdentifier = (identifier: string): string => {
  validateSchema(identifier)
  return `"${identifier}"`
}

export const migrationSql = (
  migration: PostgresMigration,
  schema: string = DEFAULT_SCHEMA
): string => {
  const replacement = quoteIdentifier(schema)
  const sql = migration.sql
    .replaceAll(MIGRATION_SCHEMA_PLACEHOLDER, replacement)
    .replaceAll('{{schema}}', replacement)
  if (sql.includes('{{SCHEMA}}') || sql.includes('{{schema}}')) {
    throw new PostgresMigrationError(
      `Migration ${migration.name} contains an unresolved schema placeholder`,
      migration.name
    )
  }
  return sql
}
