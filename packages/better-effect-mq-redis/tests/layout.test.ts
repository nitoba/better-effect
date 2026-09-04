// oxlint-disable typescript/await-thenable -- Bun's rejection matchers are thenable at runtime.
// oxlint-disable anti-slop/no-unknown-returns -- the fake Redis driver models untyped replies.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures assert their own controlled shapes.

import { describe, expect, test } from 'bun:test'

import {
  REDIS_INDEX_CONFIGURATION_CHECKSUM,
  REDIS_LAYOUT_VERSION,
  REDIS_PROTOCOL_VERSION,
  RedisLayoutMismatchError,
  ensureRedisLayout,
  makeRedisKeyLayout
} from '../src/index'
import type { RedisCommandClient, RedisSubscriberClient } from '../src/index'

class LayoutClient implements RedisCommandClient {
  readonly calls: string[][] = []
  marker: Record<string, string> = Object.create(null) as Record<string, string>
  keys: string[] = []
  private lock: string | undefined
  private lockKey: string | undefined

  async sendCommand(args: readonly string[]): Promise<unknown> {
    this.calls.push([...args])
    if (args[0] === 'HGETALL') return { ...this.marker }
    if (args[0] === 'SET') {
      this.lockKey = args[1]
      this.lock = args[2]
      return 'OK'
    }
    if (args[0] === 'GET') return this.lock
    if (args[0] === 'DEL') {
      this.lock = undefined
      this.lockKey = undefined
      return 1
    }
    if (args[0] === 'SCAN') {
      return ['0', [...this.keys, ...(this.lockKey === undefined ? [] : [this.lockKey])]]
    }
    if (args[0] === 'HSETNX') {
      this.marker[args[2]!] = args[3]!
      return 1
    }
    if (args[0] === 'HSET') {
      for (let index = 2; index < args.length; index += 2) {
        this.marker[args[index]!] = args[index + 1]!
      }
      return this.keys.length
    }
    throw new Error(`unexpected command ${args[0]}`)
  }

  duplicate(): RedisSubscriberClient {
    return { subscribe: async () => undefined }
  }
}

describe('Redis layout marker', () => {
  test('creates a marker only in an empty namespace', async () => {
    const client = new LayoutClient()
    const layout = makeRedisKeyLayout('better-effect-mq', 'notifications')
    const marker = await ensureRedisLayout(client, layout, 'script-sha', true)

    expect(marker).toEqual({
      adapterVersion: '0.1.0',
      protocolVersion: REDIS_PROTOCOL_VERSION,
      layoutVersion: REDIS_LAYOUT_VERSION,
      scriptSetChecksum: 'script-sha',
      indexConfigurationChecksum: REDIS_INDEX_CONFIGURATION_CHECKSUM
    })
    expect(client.calls.map((call) => call[0])).toEqual([
      'HGETALL',
      'SET',
      'HGETALL',
      'SCAN',
      'HSETNX',
      'HSET',
      'GET',
      'DEL'
    ])
  })

  test('rejects an unmarked non-empty namespace without deleting anything', async () => {
    const client = new LayoutClient()
    const layout = makeRedisKeyLayout('better-effect-mq', 'notifications')
    client.keys = [layout.job('existing')]

    await expect(ensureRedisLayout(client, layout, 'script-sha', true)).rejects.toBeInstanceOf(
      RedisLayoutMismatchError
    )
    expect(client.calls.map((call) => call[0])).toEqual([
      'HGETALL',
      'SET',
      'HGETALL',
      'SCAN',
      'GET',
      'DEL'
    ])
  })

  test('rejects incompatible markers and accepts compatible markers', async () => {
    const client = new LayoutClient()
    const layout = makeRedisKeyLayout('better-effect-mq', 'notifications')
    client.marker = {
      adapterVersion: '0.1.0',
      protocolVersion: REDIS_PROTOCOL_VERSION,
      layoutVersion: REDIS_LAYOUT_VERSION,
      scriptSetChecksum: 'old-script-sha',
      indexConfigurationChecksum: REDIS_INDEX_CONFIGURATION_CHECKSUM
    }

    await expect(ensureRedisLayout(client, layout, 'script-sha', true)).rejects.toBeInstanceOf(
      RedisLayoutMismatchError
    )
    client.marker.scriptSetChecksum = 'script-sha'
    await expect(ensureRedisLayout(client, layout, 'script-sha', true)).resolves.toBeDefined()
  })

  test('can explicitly skip marker I/O', async () => {
    const client = new LayoutClient()
    const layout = makeRedisKeyLayout('better-effect-mq', 'notifications')
    await expect(ensureRedisLayout(client, layout, 'script-sha', false)).resolves.toBeUndefined()
    expect(client.calls).toHaveLength(0)
  })
})
