import { expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../src/effect'
import { pipe } from '../src/function'

test('pipe composes ordinary synchronous functions', () => {
  const result = pipe(
    1,
    (value) => value.toString(),
    (value) => value.length
  )

  expect(result).toBe(1)
})

test('Effect.map transforms Ok and leaves Err untouched', () => {
  const mapped = pipe(
    Result.ok(2),
    Effect.map((value: number) => value * 2)
  )

  expect(mapped).toEqual(Result.ok(4))

  const failure = Result.err<number, string>('failed')
  let called = false

  const unchanged = Effect.map(failure, () => {
    called = true
    return 0
  })

  expect(unchanged).toBe(failure)
  expect(called).toBe(false)
})

test('Effect.mapError transforms Err and leaves Ok untouched', () => {
  const mapped = pipe(
    Result.err<number, string>('failed'),
    Effect.mapError((error: string) => error.toUpperCase())
  )

  expect(mapped).toEqual(Result.err('FAILED'))

  const success = Result.ok(2)
  let called = false

  const unchanged = Effect.mapError(success, () => {
    called = true
    return 'unexpected'
  })

  expect(unchanged).toBe(success)
  expect(called).toBe(false)
})

test('Effect.andThen runs only after Ok and short-circuits Err', () => {
  let calls = 0

  const chained = Effect.andThen(Result.ok(2), (value) => {
    calls++
    return Result.ok(value + 1)
  })

  expect(chained).toEqual(Result.ok(3))
  expect(calls).toBe(1)

  const failure = Result.err<number, string>('failed')
  const skipped = Effect.andThen(failure, () => {
    calls++
    return Result.ok(3)
  })

  expect(skipped).toBe(failure)
  expect(calls).toBe(1)
})

test('Effect combinators preserve asynchronous composition', async () => {
  const source = Promise.resolve(Result.ok(2))

  const mapped = await pipe(
    source,
    Effect.map((value: number) => value * 2)
  )

  expect(mapped).toEqual(Result.ok(4))

  const chained = await pipe(
    source,
    Effect.andThen((value: number) => Promise.resolve(Result.ok(value + 1)))
  )

  expect(chained).toEqual(Result.ok(3))
})

test('Effect.andThen composes async Effect.gen programs', async () => {
  // oxlint-disable-next-line require-yield
  const source = Effect.gen(async function* () {
    return Result.ok(2)
  })

  const result = await pipe(
    source,
    Effect.andThen((value: number) =>
      // oxlint-disable-next-line require-yield
      Effect.gen(async function* () {
        return Result.ok(value + 1)
      })
    )
  )

  expect(result).toEqual(Result.ok(3))
})
