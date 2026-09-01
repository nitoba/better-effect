import { describe, expect, test } from 'bun:test'

import { Retry } from '../src'

describe('Retry', () => {
  test('calculates fixed, linear, and exponential schedules', () => {
    expect(Retry.delay(Retry.fixed({ delayMs: 10 }).backoff, 3)).toBe(10)
    expect(Retry.delay(Retry.linear({ initialDelayMs: 10, incrementMs: 5 }).backoff, 3)).toBe(20)
    expect(Retry.delay(Retry.exponential({ initialDelayMs: 10, factor: 2 }).backoff, 3)).toBe(40)
  })

  test('clamps, jitters deterministically, and protects overflow', () => {
    const policy = Retry.exponential({ initialDelayMs: 10, factor: 2, maxDelayMs: 25, jitter: 0.2 })
    expect(Retry.delay(policy.backoff, 3, 0)).toBe(25)
    expect(Retry.delay(policy.backoff, 3, 1)).toBe(25)
    expect(
      Retry.delay({ type: 'exponential', delayMs: Number.MAX_SAFE_INTEGER, factor: 2 }, 3)
    ).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('validates policy configuration and preserves never semantics', () => {
    expect(() => Retry.linear({ initialDelayMs: 10, incrementMs: -1 })).toThrow()
    expect(() => Retry.exponential({ initialDelayMs: 10, factor: 0 })).toThrow()
    expect(Retry.never()).toEqual({ type: 'never', maxAttempts: 1 })
    expect(Object.isFrozen(Retry.fixed({ delayMs: 1 }))).toBe(true)
  })
})
