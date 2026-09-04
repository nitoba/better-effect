// oxlint-disable anti-slop/no-unknown-returns -- the fake Redis driver models untyped replies.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures assert controlled fake shapes.
// oxlint-disable anti-slop/no-known-value-widening -- test dictionaries intentionally mutate corrupt replies.

import { describe, expect, test } from 'bun:test'

import { RedisClient, RedisConfigurationError, normalizeRedisJobStoreConfig } from '../src/index'
import type { RedisCommandClient, RedisSubscriberClient } from '../src/index'

class FakeClient implements RedisCommandClient, RedisSubscriberClient {
  readonly calls: string[][] = []
  readonly closeCalls = { quit: 0, disconnect: 0, duplicate: 0 }
  readonly isOpen = true
  private readonly marker: Record<string, string> = Object.create(null) as Record<string, string>
  private lock: string | undefined

  async sendCommand(args: readonly string[]): Promise<unknown> {
    this.calls.push([...args])
    if (args[0] === 'SCRIPT' && args[1] === 'LOAD') return `${this.calls.length}`.padStart(40, '0')
    if (args[0] === 'HGETALL') return { ...this.marker }
    if (args[0] === 'SET') {
      this.lock = args[2]
      return 'OK'
    }
    if (args[0] === 'GET') return this.lock
    if (args[0] === 'DEL') {
      this.lock = undefined
      return 1
    }
    if (args[0] === 'SCAN') return ['0', []]
    if (args[0] === 'HSETNX') {
      this.marker[args[2]!] = args[3]!
      return 1
    }
    if (args[0] === 'HSET') {
      for (let index = 2; index < args.length; index += 2) {
        this.marker[args[index]!] = args[index + 1]!
      }
      return 1
    }
    throw new Error(`unexpected ${args[0]}`)
  }

  duplicate(): RedisSubscriberClient {
    this.closeCalls.duplicate += 1
    return new FakeClient()
  }

  async subscribe(): Promise<void> {}

  async quit(): Promise<void> {
    this.closeCalls.quit += 1
  }
}

const initialize = async (client: RedisClient): Promise<RedisClient> => client.initialize()

describe('Redis client ownership', () => {
  test('borrows explicitly supplied command and subscriber clients', async () => {
    const command = new FakeClient()
    const subscriber = new FakeClient()
    const redis = RedisClient.fromClients({ client: command, subscriber })
    await initialize(redis)
    await Promise.all([redis.dispose(), redis.dispose()])

    expect(redis.ownsClient).toBe(false)
    expect(redis.ownsSubscriber).toBe(false)
    expect(command.closeCalls.quit).toBe(0)
    expect(subscriber.closeCalls.quit).toBe(0)
  })

  test('duplicates and owns only the subscriber when the caller supplies one client', async () => {
    const command = new FakeClient()
    const redis = RedisClient.fromClients({ client: command })
    await initialize(redis)
    const subscriber = redis.subscriber as FakeClient
    await redis.dispose()

    expect(redis.ownsClient).toBe(false)
    expect(redis.ownsSubscriber).toBe(true)
    expect(command.closeCalls.quit).toBe(0)
    expect(subscriber.closeCalls.quit).toBe(1)
    await redis.dispose()
    expect(subscriber.closeCalls.quit).toBe(1)
  })

  test('rejects using one object for both connections', () => {
    const client = new FakeClient()
    expect(() => RedisClient.fromClients({ client, subscriber: client })).toThrow(
      RedisConfigurationError
    )
  })

  test('normalizes defaults and rejects inherited or accessor configuration fields', () => {
    const client = new FakeClient()
    const normalized = normalizeRedisJobStoreConfig({ client })
    expect(normalized.namespace).toBe('default')
    expect(normalized.prefix).toBe('better-effect-mq')
    expect(Object.isFrozen(normalized)).toBe(true)

    const inherited = Object.create({ namespace: 'hidden' }) as { client: FakeClient }
    inherited.client = client
    expect(() => normalizeRedisJobStoreConfig(inherited)).toThrow(RedisConfigurationError)

    const accessor = { client } as { client: FakeClient; prefix?: string }
    Object.defineProperty(accessor, 'prefix', {
      enumerable: true,
      get: () => 'should-not-read'
    })
    expect(() => normalizeRedisJobStoreConfig(accessor)).toThrow(RedisConfigurationError)
  })
})
