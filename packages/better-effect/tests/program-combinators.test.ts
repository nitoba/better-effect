import { expect, test } from 'bun:test'

import { Result, type Result as ResultType } from 'better-result'

import { Effect, Program } from '../src/effect'

const expectResult = (result: ResultType<any, any>, expected: ResultType<any, any>) =>
  expect(result).toEqual(expected)

test('Program.all is lazy, bounded, and preserves tuple order', async () => {
  let active = 0
  let maximum = 0
  let started = 0

  const programs = [0, 1, 2, 3, 4].map((value) =>
    Effect.fn(async function* () {
      yield* []
      started++
      active++
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active--
      return Result.ok(value)
    })
  )

  const collected = Program.all(programs, { concurrency: 2 })
  expect(started).toBe(0)

  expectResult(await collected(), Result.ok([0, 1, 2, 3, 4]))
  expect(started).toBe(5)
  expect(maximum).toBe(2)
})

test('Program.all validates concurrency before execution', () => {
  const program = Effect.fn(async function* () {
    yield* []
    return Result.ok(true)
  })

  expect(() => Program.all([program], { concurrency: 0 })).toThrow(RangeError)
  expect(() => Program.all([program], { concurrency: 1.5 })).toThrow(RangeError)
})

test('Program.all stops bounded scheduling after an observed Err and waits for claimed work', async () => {
  const failure = Result.err<number, string>('failed')
  let releaseSecond!: () => void
  let secondStarted!: () => void
  let thirdStarted = false

  const secondMayFinish = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  const secondStartedPromise = new Promise<void>((resolve) => {
    secondStarted = resolve
  })

  const programs = [
    Effect.fn(async function* () {
      yield* []
      return failure
    }),
    Effect.fn(async function* () {
      yield* []
      secondStarted()
      await secondMayFinish
      return Result.ok(1)
    }),
    Effect.fn(async function* () {
      yield* []
      thirdStarted = true
      return Result.ok(2)
    })
  ] as const

  const running = Program.all(programs, { concurrency: 2 })()

  await secondStartedPromise
  expect(thirdStarted).toBe(false)

  releaseSecond()

  const result = await running
  expect(Result.isError(result)).toBe(true)

  if (Result.isError(result)) {
    expect(result.error).toBe('failed')
  }
})

test('Program.all stops bounded scheduling after a thrown Program and waits for claimed work', async () => {
  const thrown = new Error('program failed')
  let releaseSecond!: () => void
  let secondStarted!: () => void
  let thirdStarted = false

  const secondMayFinish = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  const secondStartedPromise = new Promise<void>((resolve) => {
    secondStarted = resolve
  })

  const programs = [
    Effect.fn(async function* () {
      yield* []
      throw thrown
    }),
    Effect.fn(async function* () {
      yield* []
      secondStarted()
      await secondMayFinish
      return Result.ok(1)
    }),
    Effect.fn(async function* () {
      yield* []
      thirdStarted = true
      return Result.ok(2)
    })
  ] as const

  const running = Program.all(programs, { concurrency: 2 })()

  await secondStartedPromise
  expect(thirdStarted).toBe(false)

  releaseSecond()

  let error: unknown

  try {
    await running
  } catch (cause) {
    error = cause
  }

  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ cause: thrown })
})

test('Program.all keeps lower-index thrown failures as the primary error', async () => {
  const lowerFailure = new Error('lower failure')
  const higherFailure = new Error('higher failure')
  let releaseLower!: () => void

  const lowerMayFinish = new Promise<void>((resolve) => {
    releaseLower = resolve
  })

  const programs = [
    Effect.fn(async function* () {
      yield* []
      await lowerMayFinish
      throw lowerFailure
    }),
    Effect.fn(async function* () {
      yield* []
      throw higherFailure
    }),
    Effect.fn(async function* () {
      yield* []
      return Result.ok(2)
    })
  ] as const

  const running = Program.all(programs, { concurrency: 3 })()
  await Promise.resolve()
  releaseLower()

  let error: unknown

  try {
    await running
  } catch (cause) {
    error = cause
  }

  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ cause: lowerFailure })
})
