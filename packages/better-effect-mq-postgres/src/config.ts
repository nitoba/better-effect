// oxlint-disable anti-slop/no-runtime-typeof -- public configuration validates untyped JavaScript at its boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- public configuration validates untyped JavaScript at its boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- public configuration validates untyped JavaScript at its boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- the checked pool shape is narrowed immediately before the cast.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the pool shape is checked above.

import { PostgresConfigurationError } from './errors'
import { hasUnpairedSurrogate } from './internal/text'

export interface QueryResult<Row = unknown> {
  readonly rows: readonly Row[]
  readonly rowCount: number | null
}

export interface PoolClient {
  query<Row = unknown>(text: string, values?: readonly unknown[]): PromiseLike<QueryResult<Row>>
  release(error?: Error): void
}

export interface Pool {
  connect(): PromiseLike<PoolClient>
  query?<Row = unknown>(text: string, values?: readonly unknown[]): PromiseLike<QueryResult<Row>>
  end?(): PromiseLike<void>
}

/** Driver options accepted by the lazy `pg.Pool` constructor. */
export type PostgresPoolConfig = object

export interface PostgresJobStoreConfig {
  readonly pool: Pool
  readonly namespace?: string | undefined
  readonly schema?: string | undefined
  readonly validateSchema?: boolean | undefined
}

export interface PostgresJobStoreConnectionConfig {
  readonly connectionString?: string | undefined
  readonly poolConfig?: PostgresPoolConfig | undefined
  readonly namespace?: string | undefined
  readonly schema?: string | undefined
  readonly validateSchema?: boolean | undefined
}

export interface NormalizedPostgresJobStoreConfig {
  readonly pool: Pool
  readonly namespace: string
  readonly schema: string
  readonly validateSchema: boolean
}

export interface NormalizedPostgresJobStoreConnectionConfig {
  readonly connectionString: string | undefined
  readonly poolConfig: PostgresPoolConfig | undefined
  readonly namespace: string
  readonly schema: string
  readonly validateSchema: boolean
}

export const DEFAULT_NAMESPACE = 'default' as const
export const DEFAULT_SCHEMA = 'public' as const
export const DEFAULT_VALIDATE_SCHEMA = true as const

const isObject = (value: unknown): value is object => {
  if (value === null || typeof value !== 'object') return false
  try {
    return !Array.isArray(value)
  } catch {
    return false
  }
}

const configurationError = (field: string, message: string): PostgresConfigurationError =>
  new PostgresConfigurationError(message, field)

const readConfigObject = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object') {
    throw configurationError('config', 'configuration must be an object')
  }
  try {
    if (Array.isArray(value)) {
      throw configurationError('config', 'configuration must be an object')
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw configurationError('config', 'configuration must be a plain object')
    }
    const allowedKeys = new Set(allowed)
    const snapshot = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        throw configurationError(
          typeof key === 'string' ? key : 'config',
          'contains unsupported fields'
        )
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor)) {
        throw configurationError(key, 'must be a data property')
      }
      snapshot[key] = descriptor.value
    }
    return Object.freeze(snapshot)
  } catch (cause) {
    if (cause instanceof PostgresConfigurationError) throw cause
    throw configurationError('config', 'could not read configuration')
  }
}

export const validateNamespace = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    hasUnpairedSurrogate(value)
  ) {
    throw configurationError(
      'namespace',
      'namespace must be a non-empty well-formed string without NUL'
    )
  }

  return value
}

export const validateSchema = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(value)) {
    throw configurationError(
      'schema',
      'schema must be an ASCII PostgreSQL identifier of at most 63 characters'
    )
  }

  return value
}

const validateBoolean = (value: unknown): boolean => {
  if (value !== undefined && typeof value !== 'boolean') {
    throw configurationError('validateSchema', 'validateSchema must be a boolean')
  }

  return value === undefined ? DEFAULT_VALIDATE_SCHEMA : value
}

export const validatePool = (value: unknown): Pool => {
  if (!isObject(value)) {
    throw configurationError('pool', 'pool must expose a connect() method')
  }
  try {
    // SAFETY: `connect` is checked as a callable property before the structural pool cast.
    const candidate = value as { readonly connect?: unknown }
    if (typeof candidate.connect !== 'function') {
      throw configurationError('pool', 'pool must expose a connect() method')
    }
  } catch (cause) {
    if (cause instanceof PostgresConfigurationError) throw cause
    throw configurationError('pool', 'could not read connect()')
  }

  return value as unknown as Pool
}

export const normalizePostgresJobStoreConfig = (
  config: PostgresJobStoreConfig
): NormalizedPostgresJobStoreConfig => {
  const input = readConfigObject(config, ['pool', 'namespace', 'schema', 'validateSchema'])

  return Object.freeze({
    pool: validatePool(input.pool),
    namespace: validateNamespace(
      input.namespace === undefined ? DEFAULT_NAMESPACE : input.namespace
    ),
    schema: validateSchema(input.schema === undefined ? DEFAULT_SCHEMA : input.schema),
    validateSchema: validateBoolean(input.validateSchema)
  })
}

export const normalizePostgresJobStoreConnectionConfig = (
  config: PostgresJobStoreConnectionConfig
): NormalizedPostgresJobStoreConnectionConfig => {
  const input = readConfigObject(config, [
    'connectionString',
    'poolConfig',
    'namespace',
    'schema',
    'validateSchema'
  ])
  if (input.connectionString !== undefined && typeof input.connectionString !== 'string') {
    throw configurationError('connectionString', 'connectionString must be a string when provided')
  }
  if (
    typeof input.connectionString === 'string' &&
    (input.connectionString.length === 0 ||
      input.connectionString.includes('\u0000') ||
      hasUnpairedSurrogate(input.connectionString))
  ) {
    throw configurationError(
      'connectionString',
      'connectionString must be a non-empty well-formed string without NUL when provided'
    )
  }
  if (input.poolConfig !== undefined && !isObject(input.poolConfig)) {
    throw configurationError('poolConfig', 'poolConfig must be an object when provided')
  }

  return Object.freeze({
    connectionString: input.connectionString as string | undefined,
    poolConfig: input.poolConfig as PostgresPoolConfig | undefined,
    namespace: validateNamespace(
      input.namespace === undefined ? DEFAULT_NAMESPACE : input.namespace
    ),
    schema: validateSchema(input.schema === undefined ? DEFAULT_SCHEMA : input.schema),
    validateSchema: validateBoolean(input.validateSchema)
  })
}
