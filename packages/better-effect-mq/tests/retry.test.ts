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
    const jittered = Retry.linear({ initialDelayMs: 100, incrementMs: 0, jitter: 0.2 })
    expect(Retry.delay(jittered.backoff, 1, 0)).toBe(80)
    expect(Retry.delay(jittered.backoff, 1, 1)).toBe(120)
    expect(
      Retry.delay({ type: 'exponential', delayMs: Number.MAX_SAFE_INTEGER, factor: 2 }, 3)
    ).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('normalizes invalid random outputs without corrupting jitter', () => {
    const policy = Retry.linear({ initialDelayMs: 100, incrementMs: 0, jitter: 0.2 })
    expect(Retry.delay(policy.backoff, 1, Number.NaN)).toBe(100)
    expect(Retry.delay(policy.backoff, 1, Number.POSITIVE_INFINITY)).toBe(100)
    expect(Retry.delay(policy.backoff, 1, Number.NEGATIVE_INFINITY)).toBe(100)
    expect(Retry.delay(policy.backoff, 1, -1)).toBe(80)
    expect(Retry.delay(policy.backoff, 1, 2)).toBe(120)
  })

  test('validates policy configuration and preserves never semantics', () => {
    expect(() => Retry.linear({ initialDelayMs: 10, incrementMs: -1 })).toThrow()
    expect(() => Retry.exponential({ initialDelayMs: 10, factor: 0 })).toThrow()
    expect(Retry.never()).toEqual({ type: 'never', maxAttempts: 1 })
    expect(Object.isFrozen(Retry.fixed({ delayMs: 1 }))).toBe(true)
  })

  test('rejects unsupported and accessor factory fields without undefined option keys', () => {
    // SAFETY: these casts intentionally model untyped JavaScript callers.
    expect(() => Retry.fixed({ delayMs: 1, extra: 42 } as never)).toThrow()
    // SAFETY: these casts intentionally model untyped JavaScript callers.
    expect(() => Retry.custom({ decide: () => true, extra: 42 } as never)).toThrow()
    const fixed = Retry.fixed({ delayMs: 1 })
    expect(Object.hasOwn(fixed, 'maxAttempts')).toBe(false)
    const custom = Retry.custom({ decide: () => true })
    expect(Object.hasOwn(custom, 'maxAttempts')).toBe(false)
    const accessor = Object.defineProperty({ delayMs: 1 }, 'maxAttempts', {
      get: () => 2
    })
    // SAFETY: this cast intentionally models an untyped accessor-bearing caller.
    expect(() => Retry.fixed(accessor as never)).toThrow()
    const inheritedDelay = Object.create({
      get delayMs() {
        return 10
      }
    })
    inheritedDelay.maxAttempts = 2
    // SAFETY: this cast intentionally models an untyped inherited-accessor caller.
    expect(() => Retry.fixed(inheritedDelay as never)).toThrow()
    const inheritedDecide = Object.create({
      get decide() {
        return () => true
      }
    })
    // SAFETY: this cast intentionally models an untyped inherited-accessor caller.
    expect(() => Retry.custom(inheritedDecide as never)).toThrow()
  })
})
