// oxlint-disable anti-slop/no-runtime-typeof -- public configuration validates untyped JavaScript at its boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- mysql2 accepts an open driver option object.
// oxlint-disable anti-slop/no-unknown-parameters -- public configuration is the untyped JavaScript boundary.
// oxlint-disable anti-slop/no-unknown-returns -- the pool driver boundary is normalized by MySqlClient.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- each assertion follows a structural boundary check.

import { MySqlConfigurationError } from './errors'
import { hasUnpairedSurrogate } from './internal/text'

export interface QueryResult<Row = unknown> {
  readonly rows: readonly Row[]
  readonly rowCount: number
}

/** The subset of mysql2's PromisePool used by the adapter. */
export interface PoolConnection {
  query<Row = unknown>(sql: string, values?: readonly unknown[]): PromiseLike<QueryResult<Row>>
  execute<Row = unknown>(sql: string, values?: readonly unknown[]): PromiseLike<QueryResult<Row>>
  beginTransaction(): PromiseLike<void>
  commit(): PromiseLike<void>
  rollback(): PromiseLike<void>
  release(): void
}

export interface Pool {
  /** Accepts mysql2's PromisePool as well as a small test double. */
  getConnection(): PromiseLike<unknown>
  end?(): PromiseLike<void>
}

/** Driver options accepted by the lazy `mysql2/promise` pool constructor. */
export type MySqlPoolConfig = object

export interface MySqlJobStoreConfig {
  readonly pool: Pool
  readonly namespace?: string | undefined
  readonly validateSchema?: boolean | undefined
}

export interface MySqlJobStoreConnectionConfig {
  readonly uri?: string | undefined
  readonly poolConfig?: MySqlPoolConfig | undefined
  readonly namespace?: string | undefined
  readonly validateSchema?: boolean | undefined
}

export interface NormalizedMySqlJobStoreConfig {
  readonly pool: Pool
  readonly namespace: string
  readonly validateSchema: boolean
}

export interface NormalizedMySqlJobStoreConnectionConfig {
  readonly uri: string | undefined
  readonly poolConfig: MySqlPoolConfig | undefined
  readonly namespace: string
  readonly validateSchema: boolean
}

export const DEFAULT_NAMESPACE = 'default' as const
export const DEFAULT_VALIDATE_SCHEMA = true as const

const configurationError = (field: string, message: string): MySqlConfigurationError =>
  new MySqlConfigurationError(message, field)

const isObject = (value: unknown): value is object =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const readConfigObject = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (!isObject(value)) throw configurationError('config', 'configuration must be a plain object')
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw configurationError('config', 'configuration must be a plain object')
    const keys = new Set(allowed)
    const output = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !keys.has(key))
        throw configurationError(
          typeof key === 'string' ? key : 'config',
          'contains unsupported fields'
        )
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor))
        throw configurationError(key, 'must be a data property')
      output[key] = descriptor.value
    }
    return Object.freeze(output)
  } catch (cause) {
    if (cause instanceof MySqlConfigurationError) throw cause
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

const validateBoolean = (value: unknown): boolean => {
  if (value !== undefined && typeof value !== 'boolean')
    throw configurationError('validateSchema', 'validateSchema must be a boolean')
  return value === undefined ? DEFAULT_VALIDATE_SCHEMA : value
}

export const validatePool = (value: unknown): Pool => {
  if (!isObject(value))
    throw configurationError('pool', 'pool must expose a getConnection() method')
  try {
    const candidate = value as { readonly getConnection?: unknown }
    if (typeof candidate.getConnection !== 'function')
      throw configurationError('pool', 'pool must expose a getConnection() method')
  } catch (cause) {
    if (cause instanceof MySqlConfigurationError) throw cause
    throw configurationError('pool', 'could not read getConnection()')
  }
  return value as Pool
}

export const normalizeMySqlJobStoreConfig = (
  config: MySqlJobStoreConfig
): NormalizedMySqlJobStoreConfig => {
  const input = readConfigObject(config, ['pool', 'namespace', 'validateSchema'])
  return Object.freeze({
    pool: validatePool(input.pool),
    namespace: validateNamespace(
      input.namespace === undefined ? DEFAULT_NAMESPACE : input.namespace
    ),
    validateSchema: validateBoolean(input.validateSchema)
  })
}

export const normalizeMySqlJobStoreConnectionConfig = (
  config: MySqlJobStoreConnectionConfig
): NormalizedMySqlJobStoreConnectionConfig => {
  const input = readConfigObject(config, ['uri', 'poolConfig', 'namespace', 'validateSchema'])
  if (
    input.uri !== undefined &&
    (typeof input.uri !== 'string' ||
      input.uri.length === 0 ||
      input.uri.includes('\u0000') ||
      hasUnpairedSurrogate(input.uri))
  )
    throw configurationError(
      'uri',
      'uri must be a non-empty well-formed string without NUL when provided'
    )
  if (input.poolConfig !== undefined && !isObject(input.poolConfig))
    throw configurationError('poolConfig', 'poolConfig must be an object when provided')
  return Object.freeze({
    uri: input.uri as string | undefined,
    poolConfig: input.poolConfig as MySqlPoolConfig | undefined,
    namespace: validateNamespace(
      input.namespace === undefined ? DEFAULT_NAMESPACE : input.namespace
    ),
    validateSchema: validateBoolean(input.validateSchema)
  })
}
