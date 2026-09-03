// oxlint-disable anti-slop/no-known-value-widening -- malformed runtime inputs are intentionally exercised here.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions inject malformed JavaScript values for boundary tests.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_NAMESPACE,
  DEFAULT_SCHEMA,
  PostgresConfigurationError,
  type Pool,
  normalizePostgresJobStoreConfig,
  normalizePostgresJobStoreConnectionConfig
} from '../src/index'

const pool: Pool = {
  connect: async () => ({
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => undefined
  })
}

describe('PostgreSQL configuration', () => {
  test('applies defaults only to omitted options', () => {
    const normalized = normalizePostgresJobStoreConfig({ pool })
    expect(normalized).toMatchObject({
      namespace: DEFAULT_NAMESPACE,
      schema: DEFAULT_SCHEMA,
      validateSchema: true
    })
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(
      normalizePostgresJobStoreConnectionConfig({
        connectionString: 'postgres://localhost/db'
      })
    ).toMatchObject({
      namespace: DEFAULT_NAMESPACE,
      schema: DEFAULT_SCHEMA,
      validateSchema: true
    })
  })

  test('rejects null optional values instead of silently defaulting them', () => {
    expect(() => normalizePostgresJobStoreConfig({ pool, namespace: null as never })).toThrow(
      PostgresConfigurationError
    )
    expect(() => normalizePostgresJobStoreConfig({ pool, schema: null as never })).toThrow(
      PostgresConfigurationError
    )
    expect(() =>
      normalizePostgresJobStoreConnectionConfig({ validateSchema: null as never })
    ).toThrow(PostgresConfigurationError)
  })

  test('rejects inherited, accessor, and unknown configuration fields', () => {
    const inherited = Object.create({ namespace: 'inherited' }) as { pool: Pool }
    inherited.pool = pool
    expect(() => normalizePostgresJobStoreConfig(inherited)).toThrow(PostgresConfigurationError)

    const accessor = { pool } as { pool: Pool; schema?: string }
    Object.defineProperty(accessor, 'schema', { get: () => 'public' })
    expect(() => normalizePostgresJobStoreConfig(accessor)).toThrow(PostgresConfigurationError)

    expect(() => normalizePostgresJobStoreConfig({ pool, extra: true } as never)).toThrow(
      PostgresConfigurationError
    )
  })

  test('validates connection-backed options without loading a driver', () => {
    expect(() => normalizePostgresJobStoreConnectionConfig({ poolConfig: null as never })).toThrow(
      PostgresConfigurationError
    )
    expect(() => normalizePostgresJobStoreConnectionConfig({ connectionString: '' })).toThrow(
      PostgresConfigurationError
    )
  })
})
