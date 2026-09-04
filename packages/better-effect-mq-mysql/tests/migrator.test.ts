import { expect, test } from 'bun:test'
import {
  MIGRATION_COMPONENT,
  MYSQL_TABLES,
  MySqlMigrator,
  loadMySqlMigrations,
  migrationManifestChecksum,
  type Pool
} from '../src'

test('the immutable initial migration and forward-only InnoDB upgrade are shipped', async () => {
  const [migration, upgrade] = await loadMySqlMigrations()
  expect(migration?.sql).toContain('ENGINE=InnoDB')
  expect(migration?.sql).toContain('AUTO_INCREMENT')
  expect(migration?.sql).not.toMatch(/NOW\(\)|CURRENT_TIMESTAMP/u)
  expect(migration?.checksum).toBe(
    '3ee71810a54a89922cba9e7dccf83cd385aab03f84d7c995f806cb06876a73bd'
  )
  expect(upgrade?.version).toBe(2)
  expect(upgrade?.sql).toContain('dedupe_hash')
})

test('schema validation performs the mandatory version, SQL-mode, engine, and protocol handshake', async () => {
  const migrations = await loadMySqlMigrations()
  const checksum = migrationManifestChecksum(migrations, 2)
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
            rowCount: 4
          }
        if (sql.includes('SELECT version, checksum'))
          return { rows: [{ version: 2, checksum }], rowCount: 1 }
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
    version: 2
  })
  expect(queries.some((sql) => sql.includes('VERSION()'))).toBe(true)
  expect(queries.some((sql) => sql.includes('information_schema.tables'))).toBe(true)
})
