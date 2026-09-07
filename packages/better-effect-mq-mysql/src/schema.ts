import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MySqlMigrationError } from './errors'

export const MIGRATION_COMPONENT = 'better-effect-mq' as const
export const MYSQL_TABLES = Object.freeze({
  attempts: 'better_effect_mq_attempts',
  jobs: 'better_effect_mq_jobs',
  outbox: 'better_effect_mq_outbox',
  orderingSequences: 'better_effect_mq_ordering_sequences',
  queues: 'better_effect_mq_queues',
  schedules: 'better_effect_mq_schedules',
  schemaVersions: 'better_effect_mq_schema_versions',
  controls: 'better_effect_mq_queue_controls',
  controlCursors: 'better_effect_mq_queue_control_cursors',
  permits: 'better_effect_mq_controlled_permits',
  rateWindows: 'better_effect_mq_rate_windows',
  eventCursors: 'better_effect_mq_job_event_cursors',
  events: 'better_effect_mq_job_events'
})
/** Flow v2 uses separate tables so v1 layouts are never interpreted as flow layouts. */
export const MYSQL_FLOW_TABLES = Object.freeze({
  children: 'better_effect_mq_flow_children',
  outbox: 'better_effect_mq_flow_outbox'
})
export const MYSQL_INDEXES = Object.freeze([
  'better_effect_mq_jobs_claim_idx',
  'better_effect_mq_jobs_active_lease_idx',
  'better_effect_mq_jobs_identity_idx',
  'better_effect_mq_jobs_recent_idx',
  'better_effect_mq_jobs_run_at_idx',
  'better_effect_mq_jobs_terminal_idx',
  'better_effect_mq_jobs_idempotency_idx',
  'better_effect_mq_outbox_claim_idx',
  'better_effect_mq_outbox_active_lease_idx',
  'better_effect_mq_outbox_target_idx',
  'better_effect_mq_outbox_recent_idx',
  'better_effect_mq_schedules_due_idx',
  'better_effect_mq_schedules_group_idx',
  'better_effect_mq_schedules_key_idx',
  'better_effect_mq_jobs_dispatch_idx',
  'better_effect_mq_controlled_permits_queue_key_idx',
  'better_effect_mq_controlled_permits_job_token_idx',
  'better_effect_mq_rate_windows_expiry_idx',
  'better_effect_mq_job_events_queue_cursor_idx',
  'better_effect_mq_job_events_type_cursor_idx',
  'better_effect_mq_jobs_waiting_children_idx',
  'better_effect_mq_flow_children_parent_idx',
  'better_effect_mq_flow_children_job_idx',
  'better_effect_mq_flow_children_pending_idx',
  'better_effect_mq_flow_children_cascade_idx',
  'better_effect_mq_flow_children_job_unique',
  'better_effect_mq_flow_outbox_id_unique',
  'better_effect_mq_flow_outbox_sequence_unique',
  'better_effect_mq_flow_outbox_claim_idx',
  'better_effect_mq_flow_outbox_route_idx'
])
export interface MySqlMigration {
  readonly version: number
  readonly name: string
  readonly sql: string
  readonly checksum: string
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const parseName = (filename: string): { version: number; name: string } | undefined => {
  const match = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.sql$/u.exec(filename)
  if (match === null) return undefined
  const version = Number(match[1])
  return Number.isSafeInteger(version) && version > 0
    ? { version, name: `${match[1]}_${match[2]}` }
    : undefined
}
const directories = (): readonly string[] => {
  const current = dirname(fileURLToPath(import.meta.url))
  return [join(current, '..', 'migrations'), join(current, 'migrations')]
}
export const loadMySqlMigrations = async (): Promise<readonly MySqlMigration[]> => {
  for (const directory of directories()) {
    try {
      const files = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && parseName(entry.name) !== undefined)
        .map((entry) => entry.name)
        .sort((left, right) => (parseName(left)?.version ?? 0) - (parseName(right)?.version ?? 0))
      if (files.length === 0) continue
      const migrations = await Promise.all(
        files.map(async (file) => {
          const parsed = parseName(file)!
          const sql = await readFile(join(directory, file), 'utf8')
          return { ...parsed, sql, checksum: sha256(sql) }
        })
      )
      for (const [index, migration] of migrations.entries())
        if (migration.version !== index + 1)
          throw new MySqlMigrationError(
            `MySQL migrations must be contiguous starting at version 1 (expected ${index + 1})`,
            migration.name
          )
      return migrations
    } catch (cause) {
      if (cause instanceof MySqlMigrationError) throw cause
    }
  }
  throw new MySqlMigrationError('MySQL migrations are not included in this package')
}
export const migrationManifestChecksum = (
  migrations: readonly MySqlMigration[],
  throughVersion = migrations.at(-1)?.version ?? 0
): string => {
  const selected = migrations.filter((migration) => migration.version <= throughVersion)
  return selected.length === 1
    ? selected[0]!.checksum
    : sha256(selected.map(({ version, checksum }) => `${version}:${checksum}\n`).join(''))
}
/** Table identifiers are package constants, but quoted defensively for future custom layouts. */
export const quoteIdentifier = (identifier: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(identifier))
    throw new MySqlMigrationError('invalid MySQL identifier')
  return `\`${identifier}\``
}
