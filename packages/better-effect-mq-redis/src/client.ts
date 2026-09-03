// oxlint-disable anti-slop/no-runtime-typeof -- optional driver loading and cleanup are validated at the boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- optional redis client replies are normalized by adapter helpers.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- redis client options belong to the optional peer.
// oxlint-disable anti-slop/no-unknown-returns -- optional-driver values are normalized before use.
// oxlint-disable anti-slop/no-object-parameters -- driver options intentionally retain the peer's open shape.
// oxlint-disable anti-slop/no-known-value-widening -- structural driver assertions are narrowed immediately.
// oxlint-disable anti-slop/no-chained-type-assertions -- optional-driver casts are followed by validation.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are limited to validated driver boundaries.

import { Layer, Service } from 'better-effect'

import {
  normalizeRedisJobStoreConfig,
  normalizeRedisJobStoreConnectionConfig,
  type MaybePromise,
  validateCommandClient,
  validateRedisUrl,
  validateSubscriberClient,
  type RedisCommandClient,
  type RedisJobStoreConfig,
  type RedisJobStoreConnectionConfig,
  type RedisSubscriberClient
} from './config'
import { RedisConfigurationError, RedisConnectionError, redactedRedisError } from './errors'
import { makeRedisKeyLayout, type RedisKeyLayout } from './keys'
import { ensureRedisLayout, type RedisLayoutMarker } from './layout'
import { loadRedisScriptManifest, RedisScriptRegistry } from './script-registry'

interface RedisModule {
  readonly createClient: (options?: object) => unknown
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { readonly then?: unknown }).then === 'function'

const connectClient = async (client: RedisCommandClient | RedisSubscriberClient): Promise<void> => {
  if (client.connect === undefined || client.isOpen === true) return
  try {
    await client.connect()
  } catch (cause) {
    throw new RedisConnectionError('connect', { cause })
  }
}

const closeClient = async (
  client: RedisCommandClient | RedisSubscriberClient,
  label: string
): Promise<void> => {
  try {
    if (typeof client.quit === 'function') {
      await client.quit()
      return
    }
    if (typeof client.disconnect === 'function') {
      await client.disconnect()
      return
    }
    if (typeof client.destroy === 'function') {
      await client.destroy()
      return
    }
    if (typeof client.close === 'function') await client.close()
  } catch (cause) {
    throw new RedisConnectionError(`${label} close`, { cause })
  }
}

const closeUnknownClient = async (value: unknown, label: string): Promise<void> => {
  if (value === null || typeof value !== 'object') return
  try {
    const candidate = value as {
      readonly quit?: (...args: never[]) => MaybePromise<unknown>
      readonly disconnect?: (...args: never[]) => MaybePromise<unknown>
      readonly destroy?: (...args: never[]) => MaybePromise<unknown>
      readonly close?: (...args: never[]) => MaybePromise<unknown>
    }
    const method =
      typeof candidate.quit === 'function'
        ? candidate.quit
        : typeof candidate.disconnect === 'function'
          ? candidate.disconnect
          : typeof candidate.destroy === 'function'
            ? candidate.destroy
            : typeof candidate.close === 'function'
              ? candidate.close
              : undefined
    if (method !== undefined) await method.call(value)
  } catch (cause) {
    throw new RedisConnectionError(`${label} close`, { cause })
  }
}

const combineErrors = (errors: readonly unknown[]): unknown => {
  if (errors.length === 0) return undefined
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, 'Redis client cleanup failed')
}

const createRedisModule = async (): Promise<RedisModule> => {
  try {
    return (await import('redis')) as unknown as RedisModule
  } catch (cause) {
    throw redactedRedisError('optional redis client load', cause)
  }
}

const clientOptions = (url: string | undefined, options: object | undefined): object => {
  const output = (options === undefined ? {} : { ...options }) as Record<string, unknown>
  if (url !== undefined) output.url = url
  return output
}

/** Container-agnostic Redis command/subscriber client and namespace foundation. */
export class RedisClient extends Service<RedisClient>()('RedisClient') {
  readonly client: RedisCommandClient
  readonly subscriber: RedisSubscriberClient
  readonly layout: RedisKeyLayout
  readonly ownsClient: boolean
  readonly ownsSubscriber: boolean
  readonly namespace: string
  readonly prefix: string
  readonly validateLayout: boolean

  private readonly subscriberNeedsConnect: boolean
  private initialized: Promise<this> | undefined
  private registry: RedisScriptRegistry | undefined
  private marker: RedisLayoutMarker | undefined
  private disposal: Promise<void> | undefined
  private disposed = false
  private clientClosed = false
  private subscriberClosed = false

  constructor(
    client: RedisCommandClient,
    subscriber: RedisSubscriberClient,
    config: Pick<RedisJobStoreConfig, 'namespace' | 'prefix' | 'validateLayout'>,
    ownership: { readonly client: boolean; readonly subscriber: boolean },
    subscriberNeedsConnect = false
  ) {
    super()
    const normalized = normalizeRedisJobStoreConfig({ ...config, client, subscriber })
    if ((normalized.client as unknown) === (normalized.subscriber as unknown)) {
      throw new RedisConfigurationError(
        'command and subscriber clients must be distinct',
        'subscriber'
      )
    }
    this.client = normalized.client
    this.subscriber = normalized.subscriber!
    this.layout = makeRedisKeyLayout(normalized.prefix, normalized.namespace)
    this.ownsClient = ownership.client
    this.ownsSubscriber = ownership.subscriber
    this.namespace = normalized.namespace
    this.prefix = normalized.prefix
    this.validateLayout = normalized.validateLayout
    this.subscriberNeedsConnect = subscriberNeedsConnect
  }

  static fromClients(config: RedisJobStoreConfig): RedisClient {
    const normalized = normalizeRedisJobStoreConfig(config)
    const subscriber = normalized.subscriber ?? normalized.client.duplicate()
    if (isThenable(subscriber)) {
      throw new RedisConfigurationError(
        'subscriber',
        'duplicate() is asynchronous; provide a connected subscriber client explicitly'
      )
    }
    const checkedSubscriber = validateSubscriberClient(subscriber)
    if ((checkedSubscriber as unknown) === (normalized.client as unknown)) {
      throw new RedisConfigurationError(
        'subscriber',
        'command and subscriber clients must be distinct'
      )
    }
    return new RedisClient(
      normalized.client,
      checkedSubscriber,
      normalized,
      { client: false, subscriber: normalized.subscriber === undefined },
      normalized.subscriber === undefined
    )
  }

  /** Create owned command and subscriber connections through the optional `redis` peer. */
  static async fromConfig(config: RedisJobStoreConnectionConfig): Promise<RedisClient> {
    const normalized = normalizeRedisJobStoreConnectionConfig(config)
    const module = await createRedisModule()
    let client: RedisCommandClient | undefined
    let subscriber: RedisSubscriberClient | undefined
    let duplicate: unknown
    try {
      const created = validateCommandClient(
        module.createClient(clientOptions(normalized.url, normalized.clientOptions))
      )
      client = created
      duplicate = await created.duplicate()
      const checkedSubscriber = validateSubscriberClient(duplicate)
      if ((checkedSubscriber as unknown) === (client as unknown)) {
        throw new RedisConfigurationError('subscriber', 'duplicate() returned the command client')
      }
      subscriber = checkedSubscriber
      await connectClient(client)
      await connectClient(subscriber)
      return new RedisClient(client, subscriber, normalized, { client: true, subscriber: true })
    } catch (cause) {
      const cleanupErrors: unknown[] = []
      if (subscriber !== undefined) {
        try {
          await closeClient(subscriber, 'subscriber')
        } catch (cleanupCause) {
          cleanupErrors.push(cleanupCause)
        }
      } else if (duplicate !== undefined && duplicate !== client) {
        try {
          await closeUnknownClient(duplicate, 'subscriber')
        } catch (cleanupCause) {
          cleanupErrors.push(cleanupCause)
        }
      }
      if (client !== undefined) {
        try {
          await closeClient(client, 'command client')
        } catch (cleanupCause) {
          cleanupErrors.push(cleanupCause)
        }
      }
      const cleanup = combineErrors(cleanupErrors)
      if (cleanup !== undefined)
        throw new RedisConnectionError('client setup', {
          cause: new AggregateError([cause, cleanup])
        })
      if (cause instanceof RedisConfigurationError || cause instanceof RedisConnectionError)
        throw cause
      throw new RedisConnectionError('client setup', { cause })
    }
  }

  static layer(config: RedisJobStoreConfig): Layer<RedisClient, never> {
    return Layer.scoped(
      RedisClient,
      async () => RedisClient.fromClients(config).initialize(),
      async (client) => client.dispose()
    )
  }

  static layerFromConfig(config: RedisJobStoreConnectionConfig): Layer<RedisClient, never> {
    return Layer.scopedDisposable(RedisClient, async () => {
      const client = await RedisClient.fromConfig(config)
      return client.initialize()
    })
  }

  get scripts(): RedisScriptRegistry {
    if (this.registry === undefined) {
      throw new RedisConfigurationError('client', 'RedisClient has not been initialized')
    }
    return this.registry
  }

  get layoutMarker(): RedisLayoutMarker | undefined {
    return this.marker
  }

  async initialize(): Promise<this> {
    if (this.initialized !== undefined) return this.initialized
    if (this.disposed) throw new RedisConfigurationError('client', 'RedisClient has been disposed')
    this.initialized = this.initializeOnce()
    return this.initialized
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = this.disposeOwnedClients()
    return this.disposal
  }

  async close(): Promise<void> {
    return this.dispose()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }

  private async initializeOnce(): Promise<this> {
    try {
      if (this.subscriberNeedsConnect) await connectClient(this.subscriber)
      const registry = await RedisScriptRegistry.load(this.client, await loadRedisScriptManifest())
      const marker = await ensureRedisLayout(
        this.client,
        this.layout,
        registry.scriptSetChecksum,
        this.validateLayout
      )
      this.registry = registry
      this.marker = marker
      return this
    } catch (cause) {
      try {
        await this.dispose()
      } catch (cleanupCause) {
        throw new RedisConnectionError('initialization cleanup', {
          cause: new AggregateError([cause, cleanupCause])
        })
      }
      throw cause
    }
  }

  private async disposeOwnedClients(): Promise<void> {
    const errors: unknown[] = []
    if (this.ownsSubscriber && !this.subscriberClosed) {
      this.subscriberClosed = true
      try {
        await closeClient(this.subscriber, 'subscriber')
      } catch (cause) {
        errors.push(cause)
      }
    }
    if (this.ownsClient && !this.clientClosed) {
      this.clientClosed = true
      try {
        await closeClient(this.client, 'command client')
      } catch (cause) {
        errors.push(cause)
      }
    }
    const combined = combineErrors(errors)
    if (combined !== undefined) throw combined
  }
}

export const createRedisClient = (config: RedisJobStoreConfig): RedisClient =>
  RedisClient.fromClients(config)

export const createRedisClientFromConfig = (
  config: RedisJobStoreConnectionConfig
): Promise<RedisClient> => RedisClient.fromConfig(config)

export const validateRedisConnectionUrl = validateRedisUrl
