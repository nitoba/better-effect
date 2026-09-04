// oxlint-disable anti-slop/no-runtime-typeof -- untyped JavaScript callers are validated at this boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- public configuration accepts JavaScript values.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- Redis client options are owned by the optional driver.
// oxlint-disable anti-slop/no-chained-type-assertions -- structural client validation narrows immediately before casts.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts follow structural validation.
// oxlint-disable anti-slop/no-unknown-returns -- optional Redis client boundaries return named adapter contracts.
// oxlint-disable anti-slop/no-object-parameters -- client options are intentionally forwarded to the optional driver.

import { RedisConfigurationError } from './errors'
import { hasUnpairedSurrogate, utf8ByteLength } from './internal/text'
import { validateNamespace, validatePrefix } from './keys'

export type MaybePromise<T> = T | PromiseLike<T>

/** Send through standalone Redis clients or node-redis Cluster clients. */
export const sendRedisCommand = (
  client: RedisCommandClient,
  args: readonly string[],
  routeKey?: string
): PromiseLike<unknown> => {
  const send = client.sendCommand as unknown as (
    ...parameters: readonly unknown[]
  ) => PromiseLike<unknown>
  if (send.length >= 3)
    return send.call(client, routeKey ?? '__better_effect_mq_script_load__', false, [...args])
  return send.call(client, [...args])
}

export type RedisStandaloneCommand = (args: string[]) => PromiseLike<unknown>
export type RedisClusterCommand = (
  firstKey: string | undefined,
  isReadonly: boolean | undefined,
  args: string[],
  options?: never
) => PromiseLike<unknown>

export interface RedisCommandClient {
  readonly sendCommand: RedisStandaloneCommand | RedisClusterCommand
  duplicate(): MaybePromise<object>
  connect?(): MaybePromise<unknown>
  close?(): MaybePromise<unknown>
  quit?(): MaybePromise<unknown>
  disconnect?(): MaybePromise<unknown>
  destroy?(): MaybePromise<unknown>
  readonly isOpen?: boolean
  on?(event: string, listener: (...args: readonly unknown[]) => void): unknown
  off?(event: string, listener: (...args: readonly unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: readonly unknown[]) => void): unknown
}

export interface RedisSubscriberClient {
  // The optional Redis peer has both string and buffer-mode subscriber
  // signatures. Wake normalization narrows these calls at its boundary.
  readonly subscribe: (...args: readonly never[]) => MaybePromise<unknown>
  readonly unsubscribe?: (...args: readonly never[]) => MaybePromise<unknown>
  connect?(): MaybePromise<unknown>
  close?(): MaybePromise<unknown>
  quit?(): MaybePromise<unknown>
  disconnect?(): MaybePromise<unknown>
  destroy?(): MaybePromise<unknown>
  readonly isOpen?: boolean
  on?(event: string, listener: (...args: readonly unknown[]) => void): unknown
  off?(event: string, listener: (...args: readonly unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: readonly unknown[]) => void): unknown
}

export interface RedisJobStoreConfig {
  readonly client: RedisCommandClient
  readonly subscriber?: RedisSubscriberClient
  readonly namespace?: string
  readonly prefix?: string
  readonly validateLayout?: boolean
}

export interface RedisJobStoreConnectionConfig {
  readonly url?: string
  readonly clientOptions?: object
  readonly namespace?: string
  readonly prefix?: string
  readonly validateLayout?: boolean
}

export interface NormalizedRedisJobStoreConfig {
  readonly client: RedisCommandClient
  readonly subscriber: RedisSubscriberClient | undefined
  readonly namespace: string
  readonly prefix: string
  readonly validateLayout: boolean
}

export interface NormalizedRedisJobStoreConnectionConfig {
  readonly url: string | undefined
  readonly clientOptions: object | undefined
  readonly namespace: string
  readonly prefix: string
  readonly validateLayout: boolean
}

export const DEFAULT_NAMESPACE = 'default' as const
export const DEFAULT_PREFIX = 'better-effect-mq' as const
export const DEFAULT_VALIDATE_LAYOUT = true as const

const configurationError = (field: string, message: string): RedisConfigurationError =>
  new RedisConfigurationError(message, field)

const isObject = (value: unknown): value is object => {
  if (value === null || typeof value !== 'object') return false
  try {
    return !Array.isArray(value)
  } catch {
    return false
  }
}

const readConfigObject = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (!isObject(value)) throw configurationError('config', 'configuration must be an object')
  try {
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
    if (cause instanceof RedisConfigurationError) throw cause
    throw configurationError('config', 'could not read configuration')
  }
}

const validateBoolean = (value: unknown): boolean => {
  if (value !== undefined && typeof value !== 'boolean') {
    throw configurationError('validateLayout', 'validateLayout must be a boolean')
  }
  return value === undefined ? DEFAULT_VALIDATE_LAYOUT : value
}

const validateOptionalText = (
  value: unknown,
  field: string,
  maximumBytes: number
): string | undefined => {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    hasUnpairedSurrogate(value) ||
    utf8ByteLength(value) > maximumBytes
  ) {
    throw configurationError(
      field,
      `must be a non-empty well-formed string of at most ${maximumBytes} bytes`
    )
  }
  return value
}

const validateClientObject = (value: unknown, field: string): object => {
  if (!isObject(value)) throw configurationError(field, 'must be a Redis client object')
  return value
}

const callable = (value: object, key: string, field: string): void => {
  try {
    const candidate = value as Record<string, unknown>
    if (typeof candidate[key] !== 'function') {
      throw configurationError(field, `must expose ${key}()`)
    }
  } catch (cause) {
    if (cause instanceof RedisConfigurationError) throw cause
    throw configurationError(field, `could not read ${key}()`)
  }
}

export const validateCommandClient = (value: unknown): RedisCommandClient => {
  const client = validateClientObject(value, 'client')
  callable(client, 'sendCommand', 'client')
  callable(client, 'duplicate', 'client')
  return client as RedisCommandClient
}

export const validateSubscriberClient = (value: unknown): RedisSubscriberClient => {
  const client = validateClientObject(value, 'subscriber')
  callable(client, 'subscribe', 'subscriber')
  return client as RedisSubscriberClient
}

const snapshotOptions = (value: unknown): object | undefined => {
  if (value === undefined) return undefined
  if (!isObject(value)) throw configurationError('clientOptions', 'must be a plain object')
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw configurationError('clientOptions', 'must be a plain object')
    }
    const snapshot = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string')
        throw configurationError('clientOptions', 'must not contain symbols')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor)) {
        throw configurationError('clientOptions', 'must contain data properties')
      }
      snapshot[key] = descriptor.value
    }
    return Object.freeze(snapshot)
  } catch (cause) {
    if (cause instanceof RedisConfigurationError) throw cause
    throw configurationError('clientOptions', 'could not read options')
  }
}

const normalizeNamespace = (value: unknown): string => {
  try {
    return validateNamespace(value)
  } catch {
    throw configurationError('namespace', 'must be a valid Redis namespace')
  }
}

const normalizePrefix = (value: unknown): string => {
  try {
    return validatePrefix(value)
  } catch {
    throw configurationError('prefix', 'must be a valid Redis prefix')
  }
}

export const normalizeRedisJobStoreConfig = (
  config: RedisJobStoreConfig
): NormalizedRedisJobStoreConfig => {
  const input = readConfigObject(config, [
    'client',
    'subscriber',
    'namespace',
    'prefix',
    'validateLayout'
  ])
  return Object.freeze({
    client: validateCommandClient(input.client),
    subscriber:
      input.subscriber === undefined ? undefined : validateSubscriberClient(input.subscriber),
    namespace: normalizeNamespace(
      input.namespace === undefined ? DEFAULT_NAMESPACE : input.namespace
    ),
    prefix: normalizePrefix(input.prefix === undefined ? DEFAULT_PREFIX : input.prefix),
    validateLayout: validateBoolean(input.validateLayout)
  })
}

export const normalizeRedisJobStoreConnectionConfig = (
  config: RedisJobStoreConnectionConfig
): NormalizedRedisJobStoreConnectionConfig => {
  const input = readConfigObject(config, [
    'url',
    'clientOptions',
    'namespace',
    'prefix',
    'validateLayout'
  ])
  const url = validateOptionalText(input.url, 'url', 4096)
  return Object.freeze({
    url,
    clientOptions: snapshotOptions(input.clientOptions),
    namespace: normalizeNamespace(
      input.namespace === undefined ? DEFAULT_NAMESPACE : input.namespace
    ),
    prefix: normalizePrefix(input.prefix === undefined ? DEFAULT_PREFIX : input.prefix),
    validateLayout: validateBoolean(input.validateLayout)
  })
}

export const validateRedisUrl = (value: unknown): string => {
  const url = validateOptionalText(value, 'url', 4096)
  if (url === undefined) throw configurationError('url', 'must be provided')
  return url
}
