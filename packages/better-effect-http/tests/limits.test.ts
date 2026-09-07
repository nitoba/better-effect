import { expect, test } from 'bun:test'
import { makeHttpLimiter } from '../src/limits'

test('limits physical attempts and releases capacity', async () => {
  const limiter = makeHttpLimiter({ concurrency: 1, queue: { maxSize: 2 } })!
  const first = await limiter.admit()
  let granted = false
  const waiting = limiter.admit().then(() => {
    granted = true
  })
  await Promise.resolve()
  expect(granted).toBe(false)
  first.release()
  await waiting
  expect(granted).toBe(true)
})

test('removes an aborted waiter without consuming capacity', async () => {
  const limiter = makeHttpLimiter({ concurrency: 1 })!
  const first = await limiter.admit()
  const controller = new AbortController()
  const waiting = limiter.admit(controller.signal)
  controller.abort()
  await expect(waiting).rejects.toMatchObject({ _tag: 'HttpAbortError' })
  first.release()
  await expect(limiter.admit()).resolves.toBeDefined()
})

test('rejects a full queue with a typed admission error', async () => {
  const limiter = makeHttpLimiter({ concurrency: 1, queue: { maxSize: 1 } })!
  const first = await limiter.admit()
  void limiter.admit()
  await expect(limiter.admit()).rejects.toMatchObject({
    _tag: 'HttpLimitError',
    reason: 'queue-full'
  })
  first.release()
})
