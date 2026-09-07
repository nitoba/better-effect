import { expect, test } from 'bun:test'
import {
  MIGRATION_COMPONENT,
  MYSQL_TABLES,
  MySqlMigrator,
  loadMySqlMigrations,
  migrationManifestChecksum,
  type Pool
} from '../src'

test('the immutable initial migration and forward-only InnoDB upgrades are shipped', async () => {
  const [migration, upgrade, schedules, outbox, flows, controls, events] =
    await loadMySqlMigrations()
  expect(migration?.sql).toContain('ENGINE=InnoDB')
  expect(migration?.sql).toContain('AUTO_INCREMENT')
  expect(migration?.sql).not.toMatch(/NOW\(\)|CURRENT_TIMESTAMP/u)
  expect(migration?.checksum).toBe(
    '3ee71810a54a89922cba9e7dccf83cd385aab03f84d7c995f806cb06876a73bd'
  )
  expect(upgrade?.version).toBe(2)
  expect(upgrade?.sql).toContain('dedupe_hash')
  expect(schedules?.version).toBe(3)
  expect(schedules?.sql).toContain('better_effect_mq_schedules')
  expect(outbox?.version).toBe(4)
  expect(outbox?.sql).toContain('better_effect_mq_outbox')
  expect(outbox?.sql).toContain('metadata JSON NOT NULL')
  expect(outbox?.sql).toContain('request_digest LONGTEXT NOT NULL')
  expect(outbox?.sql).toContain('lease_token VARCHAR(255) NULL')
  expect(outbox?.sql).toContain('ordering_sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT')
  expect(outbox?.sql).toContain('better_effect_mq_outbox_claim_idx')
  expect(flows?.version).toBe(5)
  expect(flows?.sql).toContain('better_effect_mq_flow_children')
  expect(flows?.sql).toContain('better_effect_mq_flow_outbox')
  expect(flows?.sql).toContain('waiting-children')
  expect(controls?.version).toBe(6)
  expect(controls?.sql).toContain('better_effect_mq_queue_controls')
  expect(controls?.sql).toContain('better_effect_mq_controlled_permits')
  expect(controls?.sql).toContain(
    'namespace(191), queue(191), dispatch_key(191), state, priority DESC, run_at_ms, sequence, id(128)'
  )
  expect(events?.version).toBe(7)
  expect(events?.sql).toContain('better_effect_mq_job_event_cursors')
  expect(events?.sql).toContain('better_effect_mq_job_events')
})

test('migration 007 quotes the reserved event cursor column in its DDL', async () => {
  const events = (await loadMySqlMigrations())[6]
  expect(events?.sql).toContain('`cursor` BIGINT UNSIGNED NOT NULL')
  expect(events?.sql).toContain('PRIMARY KEY (namespace, `cursor`)')
  expect(events?.sql).toContain("namespace <> '' AND `cursor` > 0")
  expect(events?.sql).toContain('queue(191), `cursor`)')
  expect(events?.sql).toContain('event_type, `cursor`)')
})

test('migration 007 reconciles an existing event layout before executing its DDL', async () => {
  const migrations = await loadMySqlMigrations()
  const checksums = {
    6: migrationManifestChecksum(migrations, 6),
    7: migrationManifestChecksum(migrations, 7)
  }
  const executed: string[] = []
  let versionReads = 0
  const eventCursorColumns = ['namespace', 'next_cursor']
  const eventColumns = [
    'namespace',
    'cursor',
    'recorded_at_ms',
    'event_type',
    'job_id',
    'queue',
    'name',
    'version',
    'state',
    'attempt',
    'delivery',
    'worker_id',
    'outcome',
    'failure_kind',
    'duplicate',
    'attributes'
  ]
  const pool: Pool = {
    getConnection: async () => ({
      query: async (sql: string, values: readonly unknown[] = []) => {
        executed.push(sql)
        if (sql.includes('DATABASE() AS database_name'))
          return { rows: [{ database_name: 'better_effect_mq_test' }], rowCount: 1 }
        if (sql.includes('GET_LOCK')) return { rows: [{ acquired: 1 }], rowCount: 1 }
        if (sql.includes('RELEASE_LOCK')) return { rows: [], rowCount: 0 }
        if (sql.includes('VERSION()'))
          return { rows: [{ version: '8.0.36', comment: 'MySQL Community Server' }], rowCount: 1 }
        if (sql.includes('@@sql_mode'))
          return { rows: [{ sql_mode: 'STRICT_TRANS_TABLES' }], rowCount: 1 }
        if (sql.includes('SELECT version, checksum')) {
          versionReads += 1
          const version = versionReads === 1 ? 6 : 7
          return { rows: [{ version, checksum: checksums[version] }], rowCount: 1 }
        }
        if (sql.includes('information_schema.tables') && sql.includes('table_name IN'))
          return {
            rows: Object.values(MYSQL_TABLES).map((table_name) => ({
              table_name,
              engine: 'InnoDB'
            })),
            rowCount: Object.values(MYSQL_TABLES).length
          }
        if (sql.includes('information_schema.tables'))
          return { rows: [{ engine: 'InnoDB' }], rowCount: 1 }
        if (sql.includes('information_schema.columns')) {
          const columns =
            values[0] === MYSQL_TABLES.eventCursors ? eventCursorColumns : eventColumns
          return {
            rows: columns.map((column_name) => ({ column_name })),
            rowCount: columns.length
          }
        }
        if (sql.includes('information_schema.statistics')) {
          const table = values[0]
          const rows =
            table === MYSQL_TABLES.eventCursors
              ? [
                  {
                    index_name: 'PRIMARY',
                    non_unique: 0,
                    seq_in_index: 1,
                    column_name: 'namespace',
                    sub_part: null,
                    collation: 'A'
                  }
                ]
              : [
                  {
                    index_name: 'better_effect_mq_job_events_queue_cursor_idx',
                    non_unique: 1,
                    seq_in_index: 1,
                    column_name: 'namespace',
                    sub_part: 191,
                    collation: 'A'
                  },
                  {
                    index_name: 'better_effect_mq_job_events_queue_cursor_idx',
                    non_unique: 1,
                    seq_in_index: 2,
                    column_name: 'queue',
                    sub_part: 191,
                    collation: 'A'
                  },
                  {
                    index_name: 'better_effect_mq_job_events_queue_cursor_idx',
                    non_unique: 1,
                    seq_in_index: 3,
                    column_name: 'cursor',
                    sub_part: null,
                    collation: 'A'
                  },
                  {
                    index_name: 'better_effect_mq_job_events_type_cursor_idx',
                    non_unique: 1,
                    seq_in_index: 1,
                    column_name: 'namespace',
                    sub_part: 191,
                    collation: 'A'
                  },
                  {
                    index_name: 'better_effect_mq_job_events_type_cursor_idx',
                    non_unique: 1,
                    seq_in_index: 2,
                    column_name: 'event_type',
                    sub_part: null,
                    collation: 'A'
                  },
                  {
                    index_name: 'better_effect_mq_job_events_type_cursor_idx',
                    non_unique: 1,
                    seq_in_index: 3,
                    column_name: 'cursor',
                    sub_part: null,
                    collation: 'A'
                  },
                  {
                    index_name: 'PRIMARY',
                    non_unique: 0,
                    seq_in_index: 1,
                    column_name: 'namespace',
                    sub_part: null,
                    collation: 'A'
                  },
                  {
                    index_name: 'PRIMARY',
                    non_unique: 0,
                    seq_in_index: 2,
                    column_name: 'cursor',
                    sub_part: null,
                    collation: 'A'
                  }
                ]
          return { rows, rowCount: rows.length }
        }
        return { rows: [], rowCount: 0 }
      },
      execute: async () => ({ rows: [], rowCount: 0 }),
      beginTransaction: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined
    })
  }

  expect(await MySqlMigrator.run(pool, { appliedAtMs: 1_700_000_000_000 })).toEqual({
    component: MIGRATION_COMPONENT,
    version: 7,
    applied: [7]
  })
  expect(
    executed.filter((sql) =>
      sql.startsWith('CREATE TABLE IF NOT EXISTS better_effect_mq_job_event')
    )
  ).toHaveLength(0)
})

test('runs migration 004 when its SQL comments contain semicolons', async () => {
  const migrations = await loadMySqlMigrations()
  const checksums = {
    3: migrationManifestChecksum(migrations, 3),
    4: migrationManifestChecksum(migrations, 4),
    5: migrationManifestChecksum(migrations, 5),
    6: migrationManifestChecksum(migrations, 6),
    7: migrationManifestChecksum(migrations, 7)
  }
  const queries: string[] = []
  let versionQueries = 0
  const pool: Pool = {
    getConnection: async () => ({
      query: async (sql: string) => {
        queries.push(sql)
        if (sql.includes('DATABASE() AS database_name'))
          return { rows: [{ database_name: 'better_effect_mq_test' }], rowCount: 1 }
        if (sql.includes('GET_LOCK')) return { rows: [{ acquired: 1 }], rowCount: 1 }
        if (sql.includes('RELEASE_LOCK')) return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT version, checksum')) {
          versionQueries += 1
          const version = versionQueries === 1 ? 3 : 7
          return { rows: [{ version, checksum: checksums[version] }], rowCount: 1 }
        }
        if (sql.includes('VERSION()'))
          return { rows: [{ version: '8.0.36', comment: 'MySQL Community Server' }], rowCount: 1 }
        if (sql.includes('@@sql_mode'))
          return { rows: [{ sql_mode: 'STRICT_TRANS_TABLES' }], rowCount: 1 }
        if (sql.includes('information_schema.tables'))
          return sql.includes('table_name IN')
            ? {
                rows: Object.values(MYSQL_TABLES).map((table_name) => ({
                  table_name,
                  engine: 'InnoDB'
                })),
                rowCount: Object.values(MYSQL_TABLES).length
              }
            : { rows: [], rowCount: 0 }
        if (sql.includes('information_schema.columns'))
          return {
            rows: [
              'namespace',
              'id',
              'protocol_version',
              'target',
              'state',
              'request',
              'metadata',
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
            ].map((column_name) => ({ column_name })),
            rowCount: 19
          }
        if (sql.includes('information_schema.statistics')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 0 }
      },
      execute: async () => ({ rows: [], rowCount: 0 }),
      beginTransaction: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined
    })
  }

  const result = await MySqlMigrator.run(pool, { appliedAtMs: 1_700_000_000_000 })

  expect(result).toEqual({
    component: MIGRATION_COMPONENT,
    version: 7,
    applied: [4, 5, 6, 7]
  })
  expect(
    queries.filter(
      (sql) => sql.includes('better_effect_mq_outbox') && /(?:CREATE|ALTER) TABLE/u.test(sql)
    )
  ).toHaveLength(5)
  expect(
    queries.filter(
      (sql) => sql.includes('better_effect_mq_flow_') || sql.includes('waiting-children')
    ).length
  ).toBeGreaterThan(0)
})

test('schema validation performs the mandatory version, SQL-mode, engine, and protocol handshake', async () => {
  const migrations = await loadMySqlMigrations()
  const checksum = migrationManifestChecksum(migrations, 7)
  const queries: string[] = []
  const pool: Pool = {
    getConnection: async () => ({
      query: async (sql: string) => {
        queries.push(sql)
        if (sql.includes('VERSION()'))
          return { rows: [{ version: '8.0.36', comment: 'MySQL Community Server' }], rowCount: 1 }
        if (sql.includes('@@sql_mode'))
          return { rows: [{ sql_mode: 'STRICT_TRANS_TABLES' }], rowCount: 1 }
        if (sql.includes('information_schema.tables'))
          return {
            rows: Object.values(MYSQL_TABLES).map((table_name) => ({
              table_name,
              engine: 'InnoDB'
            })),
            rowCount: Object.values(MYSQL_TABLES).length
          }
        if (sql.includes('information_schema.columns'))
          return {
            rows: [
              'namespace',
              'id',
              'protocol_version',
              'target',
              'state',
              'request',
              'metadata',
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
            ].map((column_name) => ({ column_name })),
            rowCount: 19
          }
        if (sql.includes('SELECT version, checksum'))
          return { rows: [{ version: 7, checksum }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
      execute: async () => ({ rows: [], rowCount: 0 }),
      beginTransaction: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined
    })
  }

  const validation = await MySqlMigrator.validate(pool)
  expect(validation).toEqual({
    component: MIGRATION_COMPONENT,
    version: 7
  })
  expect(queries.some((sql) => sql.includes('VERSION()'))).toBe(true)
  expect(queries.some((sql) => sql.includes('information_schema.tables'))).toBe(true)
})
