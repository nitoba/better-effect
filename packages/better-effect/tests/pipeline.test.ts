import { expect, test } from 'bun:test'

import { Result, type Result as ResultType } from 'better-result'

import { Effect } from '../src/effect'
import { pipe } from '../src/function'

const expectResult = (result: ResultType<any, any>, expected: ResultType<any, any>) =>
  expect(result).toEqual(expected)

const expectSameResult = (result: ResultType<any, any>, expected: ResultType<any, any>) =>
  expect(result).toBe(expected)

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

  expectResult(mapped, Result.ok(4))

  const failure = Result.err<number, string>('failed')
  let called = false

  const unchanged = Effect.map(failure, () => {
    called = true
    return 0
  })

  expectSameResult(unchanged, failure)
  expect(called).toBe(false)
})

test('Effect.mapError transforms Err and leaves Ok untouched', () => {
  const mapped = pipe(
    Result.err<number, string>('failed'),
    Effect.mapError((error: string) => error.toUpperCase())
  )

  expectResult(mapped, Result.err('FAILED'))

  const success = Result.ok(2)
  let called = false

  const unchanged = Effect.mapError(success, () => {
    called = true
    return 'unexpected'
  })

  expectSameResult(unchanged, success)
  expect(called).toBe(false)
})

test('Effect.andThen runs only after Ok and short-circuits Err', () => {
  let calls = 0

  const chained = Effect.andThen(Result.ok(2), (value) => {
    calls++
    return Result.ok(value + 1)
  })

  expectResult(chained, Result.ok(3))
  expect(calls).toBe(1)

  const failure = Result.err<number, string>('failed')
  const skipped = Effect.andThen(failure, () => {
    calls++
    return Result.ok(3)
  })

  expectSameResult(skipped, failure)
  expect(calls).toBe(1)
})

test('Effect.andThenAsync always returns a Promise and preserves Err short-circuiting', async () => {
  const failure = Result.err<number, string>('failed')
  let calls = 0

  const chained = Effect.andThenAsync(failure, async (value) => {
    calls++
    return Result.ok(value + 1)
  })

  expect(chained).toBeInstanceOf(Promise)
  expectSameResult(await chained, failure)
  expect(calls).toBe(0)
})

test('Effect combinators preserve asynchronous composition', async () => {
  const source = Promise.resolve(Result.ok(2))

  const mapped = await pipe(
    source,
    Effect.map((value: number) => value * 2)
  )

  expectResult(mapped, Result.ok(4))

  const chained = await pipe(
    source,
    Effect.andThenAsync((value: number) => Promise.resolve(Result.ok(value + 1)))
  )

  expectResult(chained, Result.ok(3))
})

test('Effect.andThenAsync composes async Effect.gen programs', async () => {
  // oxlint-disable-next-line require-yield
  const source = Effect.gen(async function* () {
    return Result.ok(2)
  })

  const result = await pipe(
    source,
    Effect.andThenAsync((value: number) =>
      // oxlint-disable-next-line require-yield
      Effect.gen(async function* () {
        return Result.ok(value + 1)
      })
    )
  )

  expectResult(result, Result.ok(3))
})
