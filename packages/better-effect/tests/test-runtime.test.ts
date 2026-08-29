import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import {
  Effect,
  Layer,
  LayerDisposeError,
  Runtime,
  Service,
  ServiceNotFoundError,
  ServiceRuntime
} from '../src'
import { Clock, Logger, Random } from '../src/standard-services'
import {
  ClockTest,
  LoggerTest,
  RandomSeeded,
  TestRuntime,
  TestRuntimeObserverError,
  type RuntimeObserver
} from '../src/testing'

const captureRejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (cause) => cause
  )

type CapturedServiceResolution =
  | Clock
  | Logger
  | Random
  | ClockTest
  | LoggerTest
  | RandomSeeded
  | ServiceNotFoundError
type ConfiguredStandardService = ClockTest | LoggerTest | RandomSeeded
type StandardOptions =
  | {}
  | { readonly clock: ClockTest }
  | { readonly logger: LoggerTest }
  | { readonly random: RandomSeeded }
type ExpectedStandardServices = {
  readonly clock: ClockTest | undefined
  readonly logger: LoggerTest | undefined
  readonly random: RandomSeeded | undefined
}

const captureResolution = async (
  service: typeof Clock | typeof Logger | typeof Random
): Promise<CapturedServiceResolution> => {
  try {
    return await ServiceRuntime.resolve(service)
  } catch (cause) {
    if (cause instanceof ServiceNotFoundError) {
      return cause
    }

    throw cause
  }
}

const expectCapturedService = (
  actual: CapturedServiceResolution,
  expected: ConfiguredStandardService | undefined
): void => {
  if (expected === undefined) {
    expect(actual).toBeInstanceOf(ServiceNotFoundError)
  } else {
    expect(actual).toBe(expected)
  }
}

const assertStandardBranch = async (
  options: StandardOptions,
  expected: ExpectedStandardServices
): Promise<void> => {
  const testRuntime = await TestRuntime.make(Layer.merge(), options)

  try {
    expect(testRuntime.clock).toBe(expected.clock)
    expect(testRuntime.logger).toBe(expected.logger)
    expect(testRuntime.random).toBe(expected.random)

    const resolved = await testRuntime.run(async () => ({
      clock: await captureResolution(Clock),
      logger: await captureResolution(Logger),
      random: await captureResolution(Random)
    }))

    expectCapturedService(resolved.clock, expected.clock)
    expectCapturedService(resolved.logger, expected.logger)
    expectCapturedService(resolved.random, expected.random)
  } finally {
    await testRuntime.dispose()
  }
}

class TestDatabase extends Service<TestDatabase>()('TestRuntimeDatabase') {
  query(): string {
    return 'live'
  }
}

class TestRepository extends Service<TestRepository>()('TestRuntimeRepository') {
  load() {
    return Effect.gen(async function* () {
      const database = yield* TestDatabase
      return Result.ok(database.query())
    })
  }
}

class RequestValue extends Service<RequestValue>()('TestRuntimeRequestValue') {
  constructor(readonly value: string) {
    super()
  }
}

class DisposableService extends Service<DisposableService>()('TestRuntimeDisposable') {}

const completeLayer = Layer.merge(Layer.make(TestDatabase), Layer.make(TestRepository))
const loadRepository = Effect.fn(async function* () {
  const repository = yield* TestRepository
  const value = yield* Result.await(repository.load())
  return Result.ok(value)
})

describe('TestRuntime', () => {
  test('uses the real Runtime with controlled standard Services and records events', async () => {
    const clock = new ClockTest(new Date('2026-01-01T00:00:00.000Z'))
    const logger = new LoggerTest()
    const random = new RandomSeeded(42)
    const additionalEvents: string[] = []
    const additionalObserver: RuntimeObserver = {
      onExecutionEnd: ({ outcome }) => {
        additionalEvents.push(outcome.status)
      }
    }
    const testRuntime = await TestRuntime.make(Layer.merge(), {
      clock,
      logger,
      random,
      observers: [additionalObserver]
    })

    try {
      const result = await testRuntime.run(
        Effect.fn(async function* () {
          const currentClock = yield* Clock
          const currentLogger = yield* Logger
          const currentRandom = yield* Random
          currentLogger.info('started', { seed: currentRandom.nextInt(10) })

          return Result.ok({
            now: currentClock.now(),
            logger: currentLogger,
            random: currentRandom
          })
        })
      )

      expect(Result.isOk(result)).toBe(true)
      if (Result.isOk(result)) {
        expect(result.value.now).toEqual(new Date('2026-01-01T00:00:00.000Z'))
        expect(Object.is(result.value.logger, logger)).toBe(true)
        expect(Object.is(result.value.random, random)).toBe(true)
      }
      expect(testRuntime.clock).toBe(clock)
      expect(testRuntime.logger).toBe(logger)
      expect(testRuntime.random).toBe(random)
      expect(testRuntime.runtime).toBeInstanceOf(Runtime)
      expect(testRuntime.observer.executionStarts).toHaveLength(1)
      expect(testRuntime.observer.executionEnds).toHaveLength(1)
      expect(additionalEvents).toEqual(['success'])
      expect(logger.events).toHaveLength(1)
    } finally {
      await testRuntime[Symbol.asyncDispose]()
    }
  })

  test('installs standard Services from union-shaped options', async () => {
    const clock = new ClockTest(new Date('2026-02-01T00:00:00.000Z'))
    const logger = new LoggerTest()
    const random = new RandomSeeded(42)
    const options:
      | {}
      | {
          readonly clock: ClockTest
          readonly logger: LoggerTest
          readonly random: RandomSeeded
        } = { clock, logger, random }
    const testRuntime = await TestRuntime.make(Layer.merge(), options)

    try {
      const resolved = await testRuntime.run(async () => ({
        clock: await ServiceRuntime.resolve(Clock),
        logger: await ServiceRuntime.resolve(Logger),
        random: await ServiceRuntime.resolve(Random)
      }))

      expect(Object.is(resolved.clock, clock)).toBe(true)
      expect(Object.is(resolved.logger, logger)).toBe(true)
      expect(Object.is(resolved.random, random)).toBe(true)
    } finally {
      await testRuntime.dispose()
    }
  })

  test('only installs services selected by a union-shaped options branch', async () => {
    const clock = new ClockTest(new Date('2026-02-02T00:00:00.000Z'))
    const logger = new LoggerTest()
    const random = new RandomSeeded(42)

    await assertStandardBranch({}, { clock: undefined, logger: undefined, random: undefined })
    await assertStandardBranch({ clock }, { clock, logger: undefined, random: undefined })
    await assertStandardBranch({ logger }, { clock: undefined, logger, random: undefined })
    await assertStandardBranch({ random }, { clock: undefined, logger: undefined, random })
  })

  test('run preserves a direct Result.err value and reports failure outcome', async () => {
    const error = new Error('run failed')
    const expected = Result.err(error)
    const testRuntime = await TestRuntime.make(Layer.merge())

    try {
      const result = await testRuntime.run(() => expected)

      expect(result).toBe(expected)
      expect(testRuntime.observer.executionEnds).toHaveLength(1)
      expect(testRuntime.observer.executionEnds[0]?.outcome).toEqual({
        status: 'failure',
        cause: error
      })
    } finally {
      await testRuntime.dispose()
    }
  })

  test('run preserves a direct defect', async () => {
    const defect = new Error('run defect')
    const testRuntime = await TestRuntime.make(Layer.merge())

    try {
      const failure = await captureRejection(
        testRuntime.run(() => {
          throw defect
        })
      )

      expect(failure).toBe(defect)
      expect(testRuntime.observer.executionEnds).toHaveLength(1)
      expect(testRuntime.observer.executionEnds[0]?.outcome).toEqual({
        status: 'failure',
        cause: defect
      })
    } finally {
      await testRuntime.dispose()
    }
  })

  test('overrides providers and supports execution-local runWith Layers', async () => {
    const databaseOverride = Layer.succeed(
      TestDatabase,
      TestDatabase.of({
        query: () => 'test'
      })
    )
    const testRuntime = await TestRuntime.make(completeLayer, {
      overrides: [databaseOverride]
    })

    try {
      const overridden = await testRuntime.run(loadRepository)
      expect(Result.isOk(overridden) && overridden.value === 'test').toBe(true)

      const requestResult = await testRuntime.runWith(
        Layer.succeed(RequestValue, new RequestValue('request')),
        Effect.fn(async function* () {
          const request = yield* RequestValue
          const repository = yield* TestRepository
          return Result.ok({ request: request.value, repository })
        })
      )

      expect(Result.isOk(requestResult)).toBe(true)
      if (Result.isOk(requestResult)) {
        expect(requestResult.value.request).toBe('request')
        expect(requestResult.value.repository).toBeInstanceOf(TestRepository)
      }
    } finally {
      await testRuntime.dispose()
    }
  })

  test('isolates concurrent TestRuntime instances', async () => {
    const firstLogger = new LoggerTest()
    const secondLogger = new LoggerTest()
    const [first, second] = await Promise.all([
      TestRuntime.make(Layer.merge(), { logger: firstLogger }),
      TestRuntime.make(Layer.merge(), { logger: secondLogger })
    ])

    try {
      const [firstResult, secondResult] = await Promise.all([
        first.run(
          Effect.fn(async function* () {
            const logger = yield* Logger
            logger.info('first')
            return Result.ok(logger)
          })
        ),
        second.run(
          Effect.fn(async function* () {
            const logger = yield* Logger
            logger.info('second')
            return Result.ok(logger)
          })
        )
      ])

      expect(Result.isOk(firstResult) && Object.is(firstResult.value, firstLogger)).toBe(true)
      expect(Result.isOk(secondResult) && Object.is(secondResult.value, secondLogger)).toBe(true)
      expect(firstLogger.events).toHaveLength(1)
      expect(secondLogger.events).toHaveLength(1)
    } finally {
      await Promise.all([first.dispose(), second.dispose()])
    }
  })

  test('disposes idempotently and releases Layer resources automatically', async () => {
    let releases = 0
    const testRuntime = await TestRuntime.make(
      Layer.scoped(
        DisposableService,
        () => new DisposableService(),
        () => {
          releases++
        }
      )
    )

    await testRuntime.run(() => ServiceRuntime.resolve(DisposableService))

    const first = testRuntime[Symbol.asyncDispose]()
    const second = testRuntime.dispose()

    expect(first).toBe(second)
    await Promise.all([first, second])
    expect(releases).toBe(1)

    await testRuntime.dispose()
    expect(releases).toBe(1)
  })

  test('use preserves Result failures while disposing in finally', async () => {
    const programFailure = new Error('program failed')
    let releaseOutcome: string | undefined
    const expected = Result.err(programFailure)
    const result = await TestRuntime.use(
      Layer.scoped(
        DisposableService,
        () => new DisposableService(),
        (_service, outcome) => {
          releaseOutcome = outcome.status
        }
      ),
      {},
      async (testRuntime) => {
        await testRuntime.run(() => ServiceRuntime.resolve(DisposableService))
        return expected
      }
    )

    expect(result).toBe(expected)
    expect(releaseOutcome).toBe('failure')
  })

  test('use preserves a program defect over cleanup failure', async () => {
    const programFailure = new Error('program defect')
    const cleanupFailure = new Error('cleanup defect')

    const failure = await captureRejection(
      TestRuntime.use(
        Layer.scoped(
          DisposableService,
          () => new DisposableService(),
          () => {
            throw cleanupFailure
          }
        ),
        async (testRuntime) => {
          await testRuntime.run(() => ServiceRuntime.resolve(DisposableService))
          throw programFailure
        }
      )
    )

    expect(failure).toBe(programFailure)
  })

  test('use exposes cleanup failure after successful program completion', async () => {
    const cleanupFailure = new Error('cleanup failed')

    const failure = await captureRejection(
      TestRuntime.use(
        Layer.scoped(
          DisposableService,
          () => new DisposableService(),
          () => {
            throw cleanupFailure
          }
        ),
        async (testRuntime) => {
          await testRuntime.run(() => ServiceRuntime.resolve(DisposableService))
          return Result.ok(true)
        }
      )
    )

    expect(failure).toBeInstanceOf(LayerDisposeError)
  })

  test('reports unmatched execution events only at final disposal', async () => {
    let releaseExecution!: () => void
    let started!: () => void
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const executionMayFinish = new Promise<void>((resolve) => {
      releaseExecution = resolve
    })
    const testRuntime = await TestRuntime.make(Layer.merge())
    const execution = testRuntime.run(async () => {
      started()
      await executionMayFinish
      return Result.ok(true)
    })

    try {
      await executionStarted
      testRuntime.observer.clear()
      releaseExecution()
      const result = await execution

      expect(result).toEqual(Result.ok(true))
      const failure = await captureRejection(testRuntime.dispose())

      expect(failure).toBeInstanceOf(TestRuntimeObserverError)
      if (failure instanceof TestRuntimeObserverError) {
        expect(failure.unmatchedStarts).toHaveLength(0)
        expect(failure.unmatchedEnds).toHaveLength(1)
      }
    } finally {
      releaseExecution()
      await testRuntime.dispose().catch(() => {})
    }
  })
})
