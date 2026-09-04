// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test injects an extra runtime property.
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_NAMESPACE,
  MySqlConfigurationError,
  normalizeMySqlJobStoreConfig,
  normalizeMySqlJobStoreConnectionConfig,
  type Pool
} from '../src'

const pool: Pool = {
  getConnection: async () => ({
    query: async () => ({ rows: [], rowCount: 0 }),
    execute: async () => ({ rows: [], rowCount: 0 }),
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined
  })
}

describe('MySQL configuration', () => {
  test('normalizes owned and caller-owned pool configuration', () => {
    expect(normalizeMySqlJobStoreConfig({ pool })).toMatchObject({
      namespace: DEFAULT_NAMESPACE,
      validateSchema: true
    })
    expect(normalizeMySqlJobStoreConnectionConfig({ uri: 'mysql://localhost/jobs' })).toMatchObject(
      { namespace: DEFAULT_NAMESPACE, validateSchema: true }
    )
  })
  test('does not silently accept unsafe configuration values', () => {
    expect(() => normalizeMySqlJobStoreConfig({ pool, namespace: '' })).toThrow(
      MySqlConfigurationError
    )
    expect(() => normalizeMySqlJobStoreConfig({ pool, extra: true } as never)).toThrow(
      MySqlConfigurationError
    )
    expect(() => normalizeMySqlJobStoreConnectionConfig({ uri: '' })).toThrow(
      MySqlConfigurationError
    )
  })
})
