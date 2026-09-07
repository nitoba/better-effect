import { expect, test } from 'bun:test'
import { HttpRetry, retryAfterMs, retryableStatus } from '../src/retry'

test('retry presets validate and calculate fixed/exponential delays', () => {
  expect(HttpRetry.fixed(250)?.(3)).toBe(250)
  expect(HttpRetry.exponential({ initialMs: 100, factor: 2, maxMs: 250 })(3)).toBe(250)
  expect(HttpRetry.transient({ times: 3 }).methods).toEqual(['GET', 'HEAD', 'OPTIONS'])
  expect(() => HttpRetry.make({ times: -1 })).toThrow()
})

test('Retry-After accepts delta seconds and HTTP dates, rejecting invalid values', () => {
  expect(retryAfterMs('2', 0)).toBe(2000)
  expect(retryAfterMs('Thu, 01 Jan 1970 00:00:02 GMT', 0)).toBe(2000)
  expect(retryAfterMs('-1', 0)).toBeUndefined()
  expect(retryAfterMs('not-a-date', 0)).toBeUndefined()
})

test('transient status classification is conservative', () => {
  expect(retryableStatus(503)).toBe(true)
  expect(retryableStatus(409)).toBe(false)
  expect(retryableStatus(200)).toBe(false)
})
