import { expect, test } from 'bun:test'

import { Result, type Result as ResultType } from 'better-result'

import { Effect, Program } from '../src/effect'
import { pipe } from '../src/function'

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

test('Program map and mapError are lazy, branch-selective, and run their source once per invocation', async () => {
  const success = Result.ok(2)
  let sources = 0
  let mapped = 0
  let mappedErrors = 0

  const source = Effect.fn(function* () {
    yield* []
    sources++
    return success
  })
  const transformed = Program.map(source, (value) => {
    mapped++
    return value * 2
  })
  const errorMapped = Program.mapError(transformed, (error) => {
    mappedErrors++
    return String(error)
  })

  expect(sources).toBe(0)
  expect(mapped).toBe(0)
  expect(mappedErrors).toBe(0)
  expectResult(await errorMapped(), Result.ok(4))
  expectResult(await errorMapped(), Result.ok(4))
  expect(sources).toBe(2)
  expect(mapped).toBe(2)
  expect(mappedErrors).toBe(0)

  const failure = Result.err<number, 'missing'>('missing')
  const failed = Effect.fn(function* () {
    yield* []
    return failure
  })
  const mappedFailure = Program.mapError(failed, (error) => {
    mappedErrors++
    return `handled:${error}`
  })

  expectResult(await mappedFailure(), Result.err('handled:missing'))
  expect(mapped).toBe(2)
  expect(mappedErrors).toBe(1)
})

test('Program.map does not invoke its mapper on Err synchronously or asynchronously', async () => {
  const synchronousFailure = Result.err<number, 'sync failure'>('sync failure')
  const asynchronousFailure = Result.err<number, 'async failure'>('async failure')
  let synchronousInvocations = 0
  let asynchronousInvocations = 0

  const skippedSynchronousMapper = Program.map(
    Effect.fn(function* () {
      yield* []
      return synchronousFailure
    }),
    () => {
      synchronousInvocations++
      return 0
    }
  )
  const skippedAsynchronousMapper = Program.map(
    Effect.fn(async function* () {
      yield* []
      return asynchronousFailure
    }),
    () => {
      asynchronousInvocations++
      return 0
    }
  )

  expectResult(await skippedSynchronousMapper(), synchronousFailure)
  expectResult(await skippedAsynchronousMapper(), asynchronousFailure)
  expect(synchronousInvocations).toBe(0)
  expect(asynchronousInvocations).toBe(0)
})

test('Program.tap does not invoke its callback on Err synchronously or asynchronously', async () => {
  const synchronousFailure = Result.err<number, 'sync failure'>('sync failure')
  const asynchronousFailure = Result.err<number, 'async failure'>('async failure')
  let synchronousInvocations = 0
  let asynchronousInvocations = 0

  const skippedSynchronousTap = Program.tap(
    Effect.fn(function* () {
      yield* []
      return synchronousFailure
    }),
    () => {
      synchronousInvocations++
    }
  )
  const skippedAsynchronousTap = Program.tap(
    Effect.fn(async function* () {
      yield* []
      return asynchronousFailure
    }),
    () => {
      asynchronousInvocations++
    }
  )

  expectResult(await skippedSynchronousTap(), synchronousFailure)
  expectResult(await skippedAsynchronousTap(), asynchronousFailure)
  expect(synchronousInvocations).toBe(0)
  expect(asynchronousInvocations).toBe(0)
})

test('Program.tapError does not invoke its callback on Ok synchronously or asynchronously', async () => {
  const synchronousSuccess = Result.ok(1)
  const asynchronousSuccess = Result.ok(2)
  let synchronousInvocations = 0
  let asynchronousInvocations = 0

  const skippedSynchronousTapError = Program.tapError(
    Effect.fn(function* () {
      yield* []
      return synchronousSuccess
    }),
    () => {
      synchronousInvocations++
    }
  )
  const skippedAsynchronousTapError = Program.tapError(
    Effect.fn(async function* () {
      yield* []
      return asynchronousSuccess
    }),
    () => {
      asynchronousInvocations++
    }
  )

  expectResult(await skippedSynchronousTapError(), synchronousSuccess)
  expectResult(await skippedAsynchronousTapError(), asynchronousSuccess)
  expect(synchronousInvocations).toBe(0)
  expect(asynchronousInvocations).toBe(0)
})

test('Program combinators support data-last pipe composition', async () => {
  const source = Effect.fn(function* () {
    yield* []
    return Result.ok(2)
  })
  const piped = pipe(
    source,
    Program.map((value: number) => value * 2),
    Program.map((value: number) => String(value))
  )

  expectResult(await piped(), Result.ok('4'))
})

test('Program taps preserve original Result identity and run only their active branch', async () => {
  const success = Result.ok({ id: 'user-1' })
  const failure = Result.err<{ id: string }, 'missing'>('missing')
  const events: string[] = []

  const successful = Effect.fn(function* () {
    yield* []
    return success
  })
  const failed = Effect.fn(async function* () {
    yield* []
    return failure
  })
  const observedSuccess = Program.tap(successful, (user) => {
    events.push(`ok:${user.id}`)
  })
  const observedFailure = Program.tapError(failed, (error) => {
    events.push(`err:${error}`)
  })

  expect(Object.is(await observedSuccess(), success)).toBe(true)
  expect(Object.is(await observedFailure(), failure)).toBe(true)
  expect(events).toEqual(['ok:user-1', 'err:missing'])
})

test('Program continuations and recoveries accept Effects and Programs without eager execution', async () => {
  let sourceRuns = 0
  let effectContinuations = 0
  let programContinuations = 0
  let recoveries = 0

  const source = Effect.fn(function* () {
    yield* []
    sourceRuns++
    return Result.ok(2)
  })
  const chainedEffect = Program.andThen(source, (value) => {
    effectContinuations++
    return Effect.gen(function* () {
      yield* []
      return Result.ok(value * 2)
    })
  })
  const chainedProgram = Program.andThen(chainedEffect, (value) => {
    programContinuations++
    return Effect.fn(async function* () {
      yield* []
      return Result.ok(String(value))
    })
  })

  expect(sourceRuns).toBe(0)
  expect(effectContinuations).toBe(0)
  expect(programContinuations).toBe(0)
  expectResult(await chainedProgram(), Result.ok('4'))
  expect(sourceRuns).toBe(1)
  expect(effectContinuations).toBe(1)
  expect(programContinuations).toBe(1)

  const failure = Effect.fn(function* () {
    yield* []
    return Result.err<number, 'missing'>('missing')
  })
  const recovered = Program.recover(failure, (error) => {
    recoveries++
    return Effect.fn(async function* () {
      yield* []
      return Result.ok(error.length)
    })
  })

  expect(recoveries).toBe(0)
  expectResult(await recovered(), Result.ok(7))
  expect(recoveries).toBe(1)

  const skipped = Program.andThen(failure, () => {
    effectContinuations++
    return Result.ok(0)
  })
  const bypassed = Program.recover(source, () => {
    recoveries++
    return Result.ok(0)
  })

  expectResult(await skipped(), Result.err('missing'))
  expectResult(await bypassed(), Result.ok(2))
  expect(effectContinuations).toBe(1)
  expect(recoveries).toBe(1)
})

test('Program combinators preserve synchronous throws and asynchronous rejections', async () => {
  const synchronousFailure = new Error('synchronous failure')
  const asynchronousFailure = new Error('asynchronous failure')

  const synchronous = Effect.fn(function* () {
    yield* []
    throw synchronousFailure
  })
  const asynchronous = Effect.fn(async function* () {
    yield* []
    throw asynchronousFailure
  })
  const mappedSynchronous = Program.map(synchronous, (value) => value)
  const mappedAsynchronous = Program.map(asynchronous, (value) => value)

  let synchronousError: unknown

  try {
    void mappedSynchronous()
  } catch (cause) {
    synchronousError = cause
  }

  expect(synchronousError).toBeInstanceOf(Error)
  expect(synchronousError).toMatchObject({ cause: synchronousFailure })

  let asynchronousError: unknown

  try {
    await mappedAsynchronous()
  } catch (cause) {
    asynchronousError = cause
  }

  expect(asynchronousError).toBeInstanceOf(Error)
  expect(asynchronousError).toMatchObject({ cause: asynchronousFailure })
})
