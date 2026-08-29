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

test('Program.forEach is lazy, bounded, and preserves factory indexes and output order', async () => {
  const values = ['a', 'b', 'c', 'd'] as const
  let active = 0
  let maximum = 0
  let factories = 0

  const collected = Program.forEach(
    values,
    (value, index) => {
      factories++

      return Effect.fn(async function* () {
        yield* []
        active++
        maximum = Math.max(maximum, active)
        await new Promise<void>((resolve) => setTimeout(resolve, values.length - index))
        active--

        return Result.ok(`${index}:${value}`)
      })
    },
    { concurrency: 2 }
  )

  expect(factories).toBe(0)

  const result = await collected()
  expectResult(result, Result.ok(['0:a', '1:b', '2:c', '3:d']))
  expect(factories).toBe(values.length)
  expect(maximum).toBe(2)
})

test('Program.allResults collects typed errors and preserves exact child Results', async () => {
  const first = Result.ok('first')
  const second = Result.err<number, 'invalid'>('invalid')
  const third = Result.ok('third')
  let started = 0

  const programs = [
    Effect.fn(async function* () {
      yield* []
      started++
      await Promise.resolve()
      return first
    }),
    Effect.fn(async function* () {
      yield* []
      started++
      return second
    }),
    Effect.fn(async function* () {
      yield* []
      started++
      return third
    })
  ] as const

  const result = await Program.allResults(programs, { concurrency: 2 })()

  expectResult(result, Result.ok([first, second, third]))
  expect(Result.isError(result)).toBe(false)
  if (!Result.isError(result)) {
    expect(result.value).toHaveLength(3)
    expect(Object.is(result.value[0], first)).toBe(true)
    expect(Object.is(result.value[1], second)).toBe(true)
    expect(Object.is(result.value[2], third)).toBe(true)
  }
  expect(started).toBe(3)
})

test('Program.allResults rejects a later defect after a typed Err', async () => {
  const typedFailure = Result.err<number, 'typed'>('typed')
  const laterDefect = new Error('later defect')
  const programs = [
    Effect.fn(function* () {
      yield* []
      return typedFailure
    }),
    Effect.fn(async function* () {
      yield* []
      await Promise.resolve()
      throw laterDefect
    })
  ] as const

  let error: unknown
  try {
    await Program.allResults(programs, { concurrency: 2 })()
  } catch (cause) {
    error = cause
  }

  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ cause: laterDefect })
})

test('Program.allResults rejects a lower-index defect before a typed Err', async () => {
  const lowerDefect = new Error('lower defect')
  const typedFailure = Result.err<number, 'typed'>('typed')
  let releaseLower!: () => void
  let lowerStarted!: () => void

  const lowerMayFinish = new Promise<void>((resolve) => {
    releaseLower = resolve
  })
  const lowerStartedPromise = new Promise<void>((resolve) => {
    lowerStarted = resolve
  })
  const programs = [
    Effect.fn(async function* () {
      yield* []
      lowerStarted()
      await lowerMayFinish
      throw lowerDefect
    }),
    Effect.fn(function* () {
      yield* []
      return typedFailure
    })
  ] as const

  const running = Program.allResults(programs, { concurrency: 2 })()
  await lowerStartedPromise
  releaseLower()

  let error: unknown
  try {
    await running
  } catch (cause) {
    error = cause
  }

  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ cause: lowerDefect })
})

test('Program.allResults selects the lower defect from concurrent mixed settlement', async () => {
  const typedFailure = Result.err<number, 'typed'>('typed')
  const lowerDefect = new Error('lower defect')
  const higherDefect = new Error('higher defect')
  let releaseLower!: () => void
  let lowerStarted!: () => void
  let higherStarted = false

  const lowerMayFinish = new Promise<void>((resolve) => {
    releaseLower = resolve
  })
  const lowerStartedPromise = new Promise<void>((resolve) => {
    lowerStarted = resolve
  })
  const programs = [
    Effect.fn(function* () {
      yield* []
      return typedFailure
    }),
    Effect.fn(async function* () {
      yield* []
      lowerStarted()
      await lowerMayFinish
      throw lowerDefect
    }),
    Effect.fn(function* () {
      yield* []
      higherStarted = true
      throw higherDefect
    })
  ] as const

  const running = Program.allResults(programs, { concurrency: 3 })()
  await lowerStartedPromise
  expect(higherStarted).toBe(true)
  releaseLower()

  let error: unknown
  try {
    await running
  } catch (cause) {
    error = cause
  }

  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ cause: lowerDefect })
})

test('Program.forEach stops after failure, waits for claimed work, and prefers lower indexes', async () => {
  const typedFailure = Result.err<number, 'typed'>('typed')
  let releaseFirst!: () => void
  let firstStarted!: () => void
  let factories = 0
  let thirdStarted = false

  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve
  })

  const running = Program.forEach(
    [0, 1, 2] as const,
    (value) => {
      factories++

      if (value === 0) {
        return Effect.fn(async function* () {
          yield* []
          firstStarted()
          await firstMayFinish
          return typedFailure
        })
      }

      if (value === 1) {
        return Effect.fn(function* () {
          yield* []
          throw new Error('higher defect')
        })
      }

      return Effect.fn(function* () {
        yield* []
        thirdStarted = true
        return Result.ok(value)
      })
    },
    { concurrency: 2 }
  )()

  await firstStartedPromise
  expect(factories).toBe(2)
  expect(thirdStarted).toBe(false)

  releaseFirst()
  const result = await running

  expect(Object.is(result, typedFailure)).toBe(true)
})

test('Program.allResults stops on defects, waits for claimed work, and keeps index order', async () => {
  const lowerDefect = new Error('lower defect')
  const higherDefect = new Error('higher defect')
  let releaseLower!: () => void
  let lowerStarted!: () => void
  let thirdStarted = false

  const lowerMayFinish = new Promise<void>((resolve) => {
    releaseLower = resolve
  })
  const lowerStartedPromise = new Promise<void>((resolve) => {
    lowerStarted = resolve
  })

  const programs = [
    Effect.fn(async function* () {
      yield* []
      lowerStarted()
      await lowerMayFinish
      throw lowerDefect
    }),
    Effect.fn(function* () {
      yield* []
      throw higherDefect
    }),
    Effect.fn(function* () {
      yield* []
      thirdStarted = true
      return Result.ok(2)
    })
  ] as const

  const running = Program.allResults(programs, { concurrency: 2 })()
  await lowerStartedPromise
  expect(thirdStarted).toBe(false)

  releaseLower()

  let error: unknown
  try {
    await running
  } catch (cause) {
    error = cause
  }

  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ cause: lowerDefect })
})

test('Program collection APIs return successful empty collections', async () => {
  let factoryCalls = 0
  const emptyProgram = Effect.fn(function* () {
    yield* []
    return Result.ok(true)
  })

  const all = Program.all([] as const)
  const forEach = Program.forEach([] as const, () => {
    factoryCalls++
    return emptyProgram
  })
  const allResults = Program.allResults([] as const)

  expectResult(await all(), Result.ok([]))
  expectResult(await forEach(), Result.ok([]))
  expectResult(await allResults(), Result.ok([]))
  expect(factoryCalls).toBe(0)
})

test('Program collection APIs share concurrency validation', () => {
  const program = Effect.fn(async function* () {
    yield* []
    return Result.ok(true)
  })
  const invalidConcurrency = [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, NaN]

  for (const concurrency of invalidConcurrency) {
    expect(() => Program.all([program], { concurrency })).toThrow(RangeError)
    expect(() => Program.forEach([true], () => program, { concurrency })).toThrow(RangeError)
    expect(() => Program.allResults([program], { concurrency })).toThrow(RangeError)
  }
})

test('Program collection names reject non-string runtime values', () => {
  const program = Effect.fn(function* () {
    yield* []
    return Result.ok(true)
  })
  const invalidNames: readonly (number | { readonly value: string })[] = [
    42,
    { value: 'not-a-name' }
  ]

  for (const name of invalidNames) {
    const options = { name: 'placeholder' }
    Reflect.set(options, 'name', name)

    expect(() => Program.all([program], options)).toThrow(TypeError)
    expect(() => Program.forEach([true], () => program, options)).toThrow(TypeError)
    expect(() => Program.allResults([program], options)).toThrow(TypeError)
  }
})

test('Program collections use unbounded concurrency by default', async () => {
  let active = 0
  let maximum = 0
  const programs = Array.from({ length: 4 }, (_, value) =>
    Effect.fn(async function* () {
      yield* []
      active++
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active--
      return Result.ok(value)
    })
  )

  const result = await Program.allResults(programs)()

  expectResult(result, Result.ok(programs.map((_, index) => Result.ok(index))))
  expect(maximum).toBe(programs.length)
})

test('Program collections serialize work with concurrency one', async () => {
  let active = 0
  let maximum = 0
  const result = await Program.forEach(
    [0, 1, 2] as const,
    (value) =>
      Effect.fn(async function* () {
        yield* []
        active++
        maximum = Math.max(maximum, active)
        await Promise.resolve()
        active--
        return Result.ok(value)
      }),
    { concurrency: 1 }
  )()

  expectResult(result, Result.ok([0, 1, 2]))
  expect(maximum).toBe(1)
})

test('bounded Program collections handle large synchronously settling inputs without recursion', async () => {
  const count = 20_000
  let active = 0
  let maximum = 0
  const values = Array.from({ length: count }, (_, index) => index)
  const collected = Program.forEach(
    values,
    (value) =>
      Effect.fn(function* () {
        yield* []
        active++
        maximum = Math.max(maximum, active)
        active--
        return Result.ok(value)
      }),
    { concurrency: 4 }
  )

  const result = await collected()

  expect(Result.isError(result)).toBe(false)
  if (!Result.isError(result)) {
    expect(result.value).toHaveLength(count)
    expect(result.value[0]).toBe(0)
    expect(result.value[count - 1]).toBe(count - 1)
  }
  expect(maximum).toBe(1)
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
