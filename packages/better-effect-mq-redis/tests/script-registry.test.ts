// oxlint-disable typescript/await-thenable -- Bun's rejection matchers are thenable at runtime.
// oxlint-disable anti-slop/no-unknown-returns -- the fake Redis driver models untyped replies.

import { describe, expect, test } from 'bun:test'

import {
  RedisScriptError,
  RedisScriptRegistry,
  assertSameRedisHashSlot,
  scriptSetChecksum
} from '../src/index'
import type { RedisCommandClient, RedisSubscriberClient } from '../src/index'
import type { RedisScriptManifest } from '../src/index'

class FakeRedisClient implements RedisCommandClient {
  readonly calls: string[][] = []
  readonly scripts = new Map<string, string>()
  noScriptReplies = 0

  async sendCommand(args: readonly string[]): Promise<unknown> {
    this.calls.push([...args])
    if (args[0] === 'SCRIPT' && args[1] === 'LOAD') {
      const source = args[2]!
      const sha = `${this.scripts.size + 1}`.padStart(40, '0')
      this.scripts.set(sha, source)
      return sha
    }
    if (args[0] === 'EVALSHA') {
      if (this.noScriptReplies > 0) {
        this.noScriptReplies -= 1
        throw new Error('NOSCRIPT No matching script')
      }
      return ['ok', args[1]]
    }
    throw new Error(`unexpected command: ${args[0]}`)
  }

  duplicate(): RedisSubscriberClient {
    return this
  }

  async subscribe(): Promise<void> {}
}

const manifest: RedisScriptManifest = Object.freeze([
  Object.freeze({ name: 'enqueue', version: 1, source: 'return {KEYS[1], ARGV[1]}' })
])

describe('Redis script registry', () => {
  test('loads scripts and executes through EVALSHA', async () => {
    const client = new FakeRedisClient()
    const registry = await RedisScriptRegistry.load(client, manifest)
    expect(client.calls[0]).toEqual(['SCRIPT', 'LOAD', manifest[0]!.source])
    expect(registry.getSha('enqueue')).toHaveLength(40)
    expect(registry.scriptSetChecksum).toBe(scriptSetChecksum(manifest))

    const result = await registry.execute('enqueue', ['better-effect-mq:{ns}:job:1'], ['value'])
    expect(result).toEqual(['ok', registry.getSha('enqueue')])
    expect(client.calls.at(-1)?.[0]).toBe('EVALSHA')
    expect(client.calls.some((call) => call[0] === 'EVAL')).toBe(false)
  })

  test('reloads exactly once after NOSCRIPT and retries once', async () => {
    const client = new FakeRedisClient()
    const registry = await RedisScriptRegistry.load(client, manifest)
    client.noScriptReplies = 1

    await registry.execute('enqueue', ['better-effect-mq:{ns}:job:1'])
    expect(client.calls.map((call) => call[0])).toEqual(['SCRIPT', 'EVALSHA', 'SCRIPT', 'EVALSHA'])
  })

  test('maps a repeated NOSCRIPT to a focused script error', async () => {
    const client = new FakeRedisClient()
    const registry = await RedisScriptRegistry.load(client, manifest)
    client.noScriptReplies = 2

    await expect(
      registry.execute('enqueue', ['better-effect-mq:{ns}:job:1'])
    ).rejects.toBeInstanceOf(RedisScriptError)
    expect(client.calls.filter((call) => call[0] === 'EVALSHA')).toHaveLength(2)
  })

  test('rejects cross-slot script keys before sending a command', async () => {
    const client = new FakeRedisClient()
    const registry = await RedisScriptRegistry.load(client, manifest)
    const first = 'better-effect-mq:{ns-a}:job:1'
    const second = 'better-effect-mq:{ns-b}:job:2'
    expect(() => assertSameRedisHashSlot([first, second])).toThrow()
    await expect(registry.execute('enqueue', [first, second])).rejects.toThrow()
    expect(client.calls.filter((call) => call[0] === 'EVALSHA')).toHaveLength(0)
  })
})
