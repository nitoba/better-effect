// oxlint-disable anti-slop/no-runtime-typeof -- public configuration validates untyped JavaScript and optional driver values at its boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- public configuration accepts untyped JavaScript at its boundary.
// oxlint-disable anti-slop/no-unknown-returns -- MongoDB driver replies are intentionally opaque behind this minimal optional-peer facade.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- snapshots are immediately validated against fixed configuration fields.
// oxlint-disable anti-slop/no-object-parameters -- driver options are owned by the optional MongoDB peer.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- structural assertions follow explicit callable checks.

import { MongoJobStoreConfigurationError } from './errors'

export interface MongoCollection {
  find(
    filter?: object,
    options?: object
  ): { toArray(): Promise<readonly Record<string, unknown>[]> }
  findOne(filter: object, options?: object): Promise<Record<string, unknown> | null>
  findOneAndUpdate(filter: object, update: object, options?: object): Promise<unknown>
  updateOne(filter: object, update: object, options?: object): Promise<{ matchedCount: number }>
  deleteMany(filter: object, options?: object): Promise<unknown>
  insertMany(documents: readonly object[], options?: object): Promise<unknown>
  createIndexes(indexes: readonly object[]): Promise<unknown>
}

export interface MongoSession {
  withTransaction<T>(callback: () => Promise<T>, options?: object): Promise<T>
  endSession(): Promise<void> | void
}

export interface MongoClient {
  startSession(options?: object): MongoSession
  close(): Promise<void>
}

export interface MongoDb {
  collection(name: string): MongoCollection
  admin(): { command(command: object): Promise<Record<string, unknown>> }
  createCollection?(name: string, options?: object): Promise<unknown>
  command?(command: object): Promise<unknown>
  watch?(pipeline?: readonly object[], options?: object): MongoChangeStream
  readonly client?: MongoClient
}

export interface MongoChangeStream {
  on(event: string, listener: (value: unknown) => void): unknown
  close(): Promise<void>
}

export interface MongoJobStoreConfig {
  readonly db: MongoDb
  readonly namespace?: string
  readonly collectionPrefix?: string
  readonly validateLayout?: boolean
  readonly notifications?: 'auto' | 'poll'
}

export interface MongoJobStoreConnectionConfig {
  readonly uri: string
  readonly database: string
  readonly namespace?: string
  readonly collectionPrefix?: string
  readonly validateLayout?: boolean
  readonly notifications?: 'auto' | 'poll'
  readonly clientOptions?: object
}

export const DEFAULT_NAMESPACE = 'default' as const
export const DEFAULT_COLLECTION_PREFIX = 'better_effect_mq' as const
export const DEFAULT_VALIDATE_LAYOUT = true as const

const configError = (field: string, message: string): MongoJobStoreConfigurationError =>
  new MongoJobStoreConfigurationError(message, field)

const readObject = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw configError('config', 'configuration must be a plain object')
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw configError('config', 'configuration must be a plain object')
    const output = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !fields.includes(key))
        throw configError(typeof key === 'string' ? key : 'config', 'contains unsupported fields')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor))
        throw configError(key, 'must be a data property')
      output[key] = descriptor.value
    }
    return Object.freeze(output)
  } catch (cause) {
    if (cause instanceof MongoJobStoreConfigurationError) throw cause
    throw configError('config', 'could not read configuration')
  }
}

export const validateNamespace = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    throw configError('namespace', 'namespace must be a non-empty string without NUL')
  return value
}

export const validateCollectionPrefix = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,62}$/u.test(value))
    throw configError(
      'collectionPrefix',
      'must be an ASCII collection prefix of at most 63 characters'
    )
  return value
}

const validateDb = (value: unknown): MongoDb => {
  if (value === null || typeof value !== 'object') throw configError('db', 'must be a MongoDB Db')
  try {
    if (typeof (value as { collection?: unknown }).collection !== 'function')
      throw configError('db', 'must expose collection()')
    if (typeof (value as { admin?: unknown }).admin !== 'function')
      throw configError('db', 'must expose admin()')
    return value as MongoDb
  } catch (cause) {
    if (cause instanceof MongoJobStoreConfigurationError) throw cause
    throw configError('db', 'could not read MongoDB Db')
  }
}

export const normalizeMongoJobStoreConfig = (config: MongoJobStoreConfig) => {
  const input = readObject(config, [
    'db',
    'namespace',
    'collectionPrefix',
    'validateLayout',
    'notifications'
  ])
  if (input.validateLayout !== undefined && typeof input.validateLayout !== 'boolean')
    throw configError('validateLayout', 'must be a boolean')
  if (
    input.notifications !== undefined &&
    input.notifications !== 'auto' &&
    input.notifications !== 'poll'
  )
    throw configError('notifications', "must be 'auto' or 'poll'")
  return Object.freeze({
    db: validateDb(input.db),
    namespace: validateNamespace(input.namespace ?? DEFAULT_NAMESPACE),
    collectionPrefix: validateCollectionPrefix(input.collectionPrefix ?? DEFAULT_COLLECTION_PREFIX),
    validateLayout: input.validateLayout ?? DEFAULT_VALIDATE_LAYOUT,
    notifications: input.notifications ?? 'auto'
  })
}

export const normalizeMongoJobStoreConnectionConfig = (config: MongoJobStoreConnectionConfig) => {
  const input = readObject(config, [
    'uri',
    'database',
    'namespace',
    'collectionPrefix',
    'validateLayout',
    'notifications',
    'clientOptions'
  ])
  if (typeof input.uri !== 'string' || input.uri.length === 0 || input.uri.includes('\0'))
    throw configError('uri', 'must be a non-empty MongoDB connection URI')
  if (
    typeof input.database !== 'string' ||
    input.database.length === 0 ||
    input.database.includes('\0')
  )
    throw configError('database', 'must be a non-empty database name')
  if (
    input.clientOptions !== undefined &&
    (input.clientOptions === null ||
      typeof input.clientOptions !== 'object' ||
      Array.isArray(input.clientOptions))
  )
    throw configError('clientOptions', 'must be an object')
  return Object.freeze({
    uri: input.uri,
    database: input.database,
    namespace: validateNamespace(input.namespace ?? DEFAULT_NAMESPACE),
    collectionPrefix: validateCollectionPrefix(input.collectionPrefix ?? DEFAULT_COLLECTION_PREFIX),
    validateLayout: input.validateLayout ?? DEFAULT_VALIDATE_LAYOUT,
    notifications: input.notifications ?? 'auto',
    clientOptions: input.clientOptions as object | undefined
  })
}
