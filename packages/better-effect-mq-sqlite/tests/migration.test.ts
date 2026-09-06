// oxlint-disable anti-slop/no-runtime-typeof -- SQLite catalog values are narrowed at this test boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the selected catalog columns are checked immediately below.

import { createHash } from 'node:crypto'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  MIGRATION_COMPONENT,
  SQLITE_INDEXES,
  SQLITE_TABLES,
  SqliteMigrator,
  SqliteSchemaValidationError,
  migrationSql
} from '../src'

const databases: Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const open = (): Database => {
  const database = new Database(':memory:')
  databases.push(database)
  return database
}

type CatalogRow = { readonly name?: unknown }
type VersionRow = { readonly version?: unknown }

test('migration 2 installs schedules and is idempotent', () => {
  const database = open()

  expect(SqliteMigrator.migrate({ database, appliedAtMs: 7 })).toEqual({
    component: MIGRATION_COMPONENT,
    version: 2,
    applied: [1, 2]
  })
  expect(SqliteMigrator.migrate({ database, appliedAtMs: 8 })).toEqual({
    component: MIGRATION_COMPONENT,
    version: 2,
    applied: []
  })

  const tables = new Set(
    (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as readonly (
        | CatalogRow
        | undefined
      )[]
    ).flatMap((row) => (typeof row?.name === 'string' ? [row.name] : []))
  )
  expect(tables.has(SQLITE_TABLES.schedules)).toBe(true)
  const indexes = new Set(
    (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as readonly (
        | CatalogRow
        | undefined
      )[]
    ).flatMap((row) => (typeof row?.name === 'string' ? [row.name] : []))
  )
  for (const index of SQLITE_INDEXES.slice(-3)) expect(indexes.has(index)).toBe(true)
  const version = database.prepare(`SELECT version FROM ${SQLITE_TABLES.schemaVersions}`).get() as
    | VersionRow
    | null
    | undefined
  expect(version?.version).toBe(2)
})

test('migration 2 upgrades a version-one layout', () => {
  const database = open()
  database.exec(migrationSql)
  const initialChecksum = createHash('sha256').update(migrationSql, 'utf8').digest('hex')
  database
    .prepare(
      `INSERT INTO ${SQLITE_TABLES.schemaVersions}(component, version, applied_at_ms, checksum) VALUES(?, ?, ?, ?)`
    )
    .run(MIGRATION_COMPONENT, 1, 1, initialChecksum)

  expect(SqliteMigrator.migrate({ database, appliedAtMs: 9 }).applied).toEqual([2])
  expect(SqliteMigrator.validate(database).version).toBe(2)
})

describe('migration 2 layout validation', () => {
  test('rejects a missing schedule index', () => {
    const database = open()
    SqliteMigrator.migrate({ database })
    database.exec(`DROP INDEX ${SQLITE_INDEXES[8]}`)

    expect(() => SqliteMigrator.validate(database)).toThrow(SqliteSchemaValidationError)
  })
})
