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
  migrationSql,
  scheduleMigrationSql
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

test('migration 6 installs controls, schedules, outbox, flow, and event tables and is idempotent', () => {
  const database = open()

  expect(SqliteMigrator.migrate({ database, appliedAtMs: 7 })).toEqual({
    component: MIGRATION_COMPONENT,
    version: 6,
    applied: [1, 2, 3, 4, 5, 6]
  })
  expect(SqliteMigrator.migrate({ database, appliedAtMs: 8 })).toEqual({
    component: MIGRATION_COMPONENT,
    version: 6,
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
  expect(tables.has(SQLITE_TABLES.outbox)).toBe(true)
  expect(tables.has(SQLITE_TABLES.flowChildren)).toBe(true)
  expect(tables.has(SQLITE_TABLES.flowOutbox)).toBe(true)
  expect(tables.has(SQLITE_TABLES.controls)).toBe(true)
  expect(tables.has(SQLITE_TABLES.controlCursors)).toBe(true)
  expect(tables.has(SQLITE_TABLES.permits)).toBe(true)
  expect(tables.has(SQLITE_TABLES.rateWindows)).toBe(true)
  expect(tables.has(SQLITE_TABLES.eventCursors)).toBe(true)
  expect(tables.has(SQLITE_TABLES.events)).toBe(true)
  const indexes = new Set(
    (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as readonly (
        | CatalogRow
        | undefined
      )[]
    ).flatMap((row) => (typeof row?.name === 'string' ? [row.name] : []))
  )
  for (const index of SQLITE_INDEXES.slice(-4)) expect(indexes.has(index)).toBe(true)
  const version = database.prepare(`SELECT version FROM ${SQLITE_TABLES.schemaVersions}`).get() as
    | VersionRow
    | null
    | undefined
  expect(version?.version).toBe(6)
})

test('migration 6 preserves foreign-key integrity when the connection has enforcement enabled', () => {
  const database = open()
  database.exec('PRAGMA foreign_keys = ON')

  expect(SqliteMigrator.migrate({ database }).version).toBe(6)
  expect(database.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
  expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

test('migration 6 upgrades a version-one layout', () => {
  const database = open()
  database.exec(migrationSql)
  const initialChecksum = createHash('sha256').update(migrationSql, 'utf8').digest('hex')
  database
    .prepare(
      `INSERT INTO ${SQLITE_TABLES.schemaVersions}(component, version, applied_at_ms, checksum) VALUES(?, ?, ?, ?)`
    )
    .run(MIGRATION_COMPONENT, 1, 1, initialChecksum)

  expect(SqliteMigrator.migrate({ database, appliedAtMs: 9 }).applied).toEqual([2, 3, 4, 5, 6])
  expect(SqliteMigrator.validate(database).version).toBe(6)
})

test('migration 6 upgrades a version-two layout without changing the v2 checksum', () => {
  const database = open()
  database.exec(migrationSql)
  const initialChecksum = createHash('sha256').update(migrationSql, 'utf8').digest('hex')
  const scheduleChecksum = createHash('sha256').update(scheduleMigrationSql, 'utf8').digest('hex')
  const versionTwoChecksum = createHash('sha256')
    .update(`1:${initialChecksum}\n2:${scheduleChecksum}\n`, 'utf8')
    .digest('hex')
  database.exec(scheduleMigrationSql)
  database
    .prepare(
      `INSERT INTO ${SQLITE_TABLES.schemaVersions}(component, version, applied_at_ms, checksum) VALUES(?, ?, ?, ?)`
    )
    .run(MIGRATION_COMPONENT, 2, 1, versionTwoChecksum)

  expect(SqliteMigrator.migrate({ database, appliedAtMs: 9 }).applied).toEqual([3, 4, 5, 6])
  expect(SqliteMigrator.validate(database).version).toBe(6)
})

describe('migration 3 layout validation', () => {
  test('rejects a missing schedule index', () => {
    const database = open()
    SqliteMigrator.migrate({ database })
    database.exec(`DROP INDEX ${SQLITE_INDEXES[8]}`)

    expect(() => SqliteMigrator.validate(database)).toThrow(SqliteSchemaValidationError)
  })

  test('rejects a v2 flow layout with a missing flow table', () => {
    const database = open()
    SqliteMigrator.migrate({ database })
    database.exec(`DROP TABLE ${SQLITE_TABLES.flowOutbox}`)

    expect(() => SqliteMigrator.validate(database)).toThrow(SqliteSchemaValidationError)
  })
})
