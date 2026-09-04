// oxlint-disable anti-slop/no-runtime-typeof -- configuration is an untyped JavaScript boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- configuration and driver values are validated at this boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQLite rows are structurally supplied by host drivers.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to the validated driver boundary.
import { SqliteConfigurationError } from './errors'

export interface SqliteStatement {
  all(...parameters: readonly unknown[]): readonly (Record<string, unknown> | undefined)[]
  get(...parameters: readonly unknown[]): Record<string, unknown> | undefined | null
  run(...parameters: readonly unknown[]): {
    readonly changes: number
    readonly lastInsertRowid?: number | bigint
  }
}

/** Structural subset shared by Node's DatabaseSync and Bun's Database. */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  close?(): void
}

export interface SqliteJobStoreConfig {
  readonly database: SqliteDatabase
  readonly namespace?: string
  readonly configurePragmas?: boolean
  readonly busyTimeoutMs?: number
  readonly validateSchema?: boolean
  /** Poll interval used to discover commits from another local process. */
  readonly pollIntervalMs?: number
}

export interface NormalizedSqliteJobStoreConfig {
  readonly database: SqliteDatabase
  readonly namespace: string
  readonly configurePragmas: boolean
  readonly busyTimeoutMs: number
  readonly validateSchema: boolean
  readonly pollIntervalMs: number
}

export const DEFAULT_NAMESPACE = 'default' as const
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000 as const
export const DEFAULT_POLL_INTERVAL_MS = 1_000 as const

const error = (field: string, message: string): SqliteConfigurationError =>
  new SqliteConfigurationError(message, field)

const object = (value: unknown, field: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw error(field, 'must be a plain object')
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw error(field, 'must be a plain object')
    const out = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw error(field, 'contains an unsupported field')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor))
        throw error(key, 'must be a data property')
      out[key] = descriptor.value
    }
    return out
  } catch (cause) {
    if (cause instanceof SqliteConfigurationError) throw cause
    throw error(field, 'could not read configuration')
  }
}

export const validateNamespace = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw error('namespace', 'must be a non-empty string without NUL')
  }
  return value
}

export const validateDatabase = (value: unknown): SqliteDatabase => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw error('database', 'must expose prepare() and exec()')
  }
  try {
    const candidate = value as { readonly prepare?: unknown; readonly exec?: unknown }
    if (typeof candidate.prepare !== 'function' || typeof candidate.exec !== 'function') {
      throw error('database', 'must expose prepare() and exec()')
    }
  } catch (cause) {
    if (cause instanceof SqliteConfigurationError) throw cause
    throw error('database', 'could not read database methods')
  }
  return value as SqliteDatabase
}

const nonNegativeInteger = (value: unknown, field: string, fallback: number): number => {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw error(field, 'must be a non-negative safe integer')
  }
  return value as number
}

export const normalizeSqliteJobStoreConfig = (
  config: SqliteJobStoreConfig
): NormalizedSqliteJobStoreConfig => {
  const input = object(config, 'config')
  const allowed = new Set([
    'database',
    'namespace',
    'configurePragmas',
    'busyTimeoutMs',
    'validateSchema',
    'pollIntervalMs'
  ])
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw error(key, 'is not supported')
  if (input.configurePragmas !== undefined && typeof input.configurePragmas !== 'boolean') {
    throw error('configurePragmas', 'must be a boolean')
  }
  if (input.validateSchema !== undefined && typeof input.validateSchema !== 'boolean') {
    throw error('validateSchema', 'must be a boolean')
  }
  return Object.freeze({
    database: validateDatabase(input.database),
    namespace: validateNamespace(input.namespace ?? DEFAULT_NAMESPACE),
    configurePragmas: input.configurePragmas ?? false,
    busyTimeoutMs: nonNegativeInteger(
      input.busyTimeoutMs,
      'busyTimeoutMs',
      DEFAULT_BUSY_TIMEOUT_MS
    ),
    validateSchema: input.validateSchema ?? true,
    pollIntervalMs: (() => {
      const value = nonNegativeInteger(
        input.pollIntervalMs,
        'pollIntervalMs',
        DEFAULT_POLL_INTERVAL_MS
      )
      if (value === 0) throw error('pollIntervalMs', 'must be positive')
      return value
    })()
  })
}
