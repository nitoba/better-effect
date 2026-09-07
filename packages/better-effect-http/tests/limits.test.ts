// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the listener probe uses a structural AbortSignal test double.
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
  const aborted = await waiting.then(
    () => undefined,
    (error) => error
  )
  expect(aborted).toMatchObject({ _tag: 'HttpAbortError' })
  first.release()
  expect(await limiter.admit()).toBeDefined()
})

test('rejects a full queue with a typed admission error', async () => {
  const limiter = makeHttpLimiter({ concurrency: 1, queue: { maxSize: 1 } })!
  const first = await limiter.admit()
  void limiter.admit()
  const full = await limiter.admit().then(
    () => undefined,
    (error) => error
  )
  expect(full).toMatchObject({
    _tag: 'HttpLimitError',
    reason: 'queue-full'
  })
  first.release()
})

test('removes the abort listener when an admission is granted', async () => {
  const limiter = makeHttpLimiter({ concurrency: 1 })!
  const target = new EventTarget()
  let added = 0
  let removed = 0
  const add = target.addEventListener.bind(target)
  const remove = target.removeEventListener.bind(target)
  target.addEventListener = ((...args: Parameters<typeof target.addEventListener>) => {
    added++
    return add(...args)
  }) as typeof target.addEventListener
  target.removeEventListener = ((...args: Parameters<typeof target.removeEventListener>) => {
    removed++
    return remove(...args)
  }) as typeof target.removeEventListener
  const signal = Object.assign(target, { aborted: false }) as AbortSignal

  const admission = await limiter.admit(signal)

  expect(added).toBe(1)
  expect(removed).toBe(1)
  admission.release()
})
