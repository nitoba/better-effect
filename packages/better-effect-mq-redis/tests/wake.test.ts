// oxlint-disable anti-slop/no-chained-type-assertions -- fake subscriber overloads are narrowed at the test boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- the fake models the optional Redis peer.
// oxlint-disable typescript/await-thenable -- Bun's rejection matchers are thenable at runtime.

import { describe, expect, test } from 'bun:test'
import { subscribeWake } from '../src/internal/wake'
import type { RedisSubscriberClient } from '../src/config'

type WakeListener = (message: string, channel: string) => Promise<void>
type FakeSubscriber = {
  subscribe: (channel: string, listener: WakeListener) => Promise<void>
  unsubscribe: (channel: string, listener: WakeListener) => Promise<void>
  on?: (event: string, listener: () => void) => void
  off?: (event: string, listener: () => void) => void
}

const asRedisSubscriber = (subscriber: FakeSubscriber): RedisSubscriberClient => {
  // SAFETY: the fake implements the subscribe/unsubscribe contract used by subscribeWake.
  return subscriber as unknown as RedisSubscriberClient
}

describe('Redis wake subscription', () => {
  test('does not attach callbacks when unsubscribe is unavailable', async () => {
    let subscriptions = 0
    const subscriber = {
      subscribe: async () => {
        subscriptions += 1
      }
    }
    // SAFETY: this fake intentionally omits unsubscribe to model polling fallback.
    const redisSubscriber = subscriber as unknown as RedisSubscriberClient

    const cleanup = await subscribeWake(redisSubscriber, 'wake', async () => undefined)
    await cleanup()
    expect(subscriptions).toBe(0)
  })

  test('removes a callback when initial subscription fails', async () => {
    let unsubscriptions = 0
    const subscriber = asRedisSubscriber({
      subscribe: async () => {
        throw new Error('subscribe failed')
      },
      unsubscribe: async () => {
        unsubscriptions += 1
      }
    })

    await expect(subscribeWake(subscriber, 'wake', async () => undefined)).rejects.toThrow(
      'subscribe failed'
    )
    expect(unsubscriptions).toBe(1)
  })

  test('does not install reconnect listeners for borrowed subscribers', async () => {
    let eventListeners = 0
    let unsubscriptions = 0
    const subscriber = asRedisSubscriber({
      subscribe: async () => undefined,
      unsubscribe: async () => {
        unsubscriptions += 1
      },
      on: () => {
        eventListeners += 1
      },
      off: () => undefined
    })

    const cleanup = await subscribeWake(subscriber, 'wake', async () => undefined, undefined, false)
    await cleanup()
    expect(eventListeners).toBe(0)
    expect(unsubscriptions).toBe(1)
  })
})
