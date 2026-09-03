import { afterEach, describe, expect, test } from 'bun:test'

import { RedisClient } from '../../src/index'

const url = process.env.REDIS_URL
const integration = url === undefined ? test.skip : test
let client: RedisClient | undefined

describe('Redis client foundation on Redis/Valkey', () => {
  afterEach(async () => {
    await client?.dispose()
    client = undefined
  })

  integration('connects, loads scripts, and validates an isolated namespace', async () => {
    if (url === undefined) return
    client = await RedisClient.fromConfig({
      url,
      namespace: `integration-${process.pid}`,
      prefix: 'better-effect-mq-test'
    })
    await client.initialize()
    expect(client.scripts.getSha('enqueue')).toMatch(/^[0-9a-f]{40}$/u)
    expect(client.layoutMarker?.layoutVersion).toBe('1')
  })
})
