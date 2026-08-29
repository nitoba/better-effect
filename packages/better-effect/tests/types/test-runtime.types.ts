import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect, Layer, Runtime, Service, type EffectRequirements } from '../../src'
import {
  Clock,
  ClockTest,
  Logger,
  LoggerTest,
  Random,
  RandomSeeded
} from '../../src/standard-services'
import { TestRuntime, type TestRuntimeOptions } from '../../src/testing'

class Database extends Service<Database>()('TestRuntimeDatabase') {
  query(): string {
    return 'database'
  }
}

class Repository extends Service<Repository>()('TestRuntimeRepository') {
  load() {
    return Effect.gen(async function* () {
      const database = yield* Database
      return Result.ok(database.query())
    })
  }
}

class IncompatibleDatabase extends Service<IncompatibleDatabase>()('TestRuntimeDatabase') {
  write(): void {}
}

class IncompatibleClock extends Service<IncompatibleClock>()('Clock') {
  now(): string {
    return ''
  }

  sleep(): Promise<void> {
    return Promise.resolve()
  }
}

class IncompatibleLogger extends Service<IncompatibleLogger>()('Logger') {
  log(message: string): void {
    void message
  }
}

class IncompatibleRandom extends Service<IncompatibleRandom>()('Random') {
  next(): string {
    return ''
  }
}

const databaseLayer = Layer.make(Database)
const incompatibleClockLayer = Layer.make(IncompatibleClock)
const incompatibleLoggerLayer = Layer.make(IncompatibleLogger)
const incompatibleRandomLayer = Layer.make(IncompatibleRandom)
const repositoryLayer = Layer.make(Repository)
const completeLayer = Layer.merge(databaseLayer, repositoryLayer)
const databaseTest = Layer.succeed(Database, new Database())

const typedOptions = {
  overrides: [databaseTest]
} satisfies TestRuntime.Options<typeof completeLayer, readonly [typeof databaseTest]>
void typedOptions

const predeclaredOverrides = [databaseTest] as const
const predeclaredOptions = {
  overrides: predeclaredOverrides
} satisfies TestRuntime.Options<typeof repositoryLayer, typeof predeclaredOverrides>
const predeclaredRuntime = TestRuntime.make(repositoryLayer, predeclaredOptions)
expectTypeOf<Awaited<typeof predeclaredRuntime>['runtime']>().toEqualTypeOf<
  Runtime<Database | Repository>
>()
const explicitlyTypedOptions: TestRuntime.Options<
  typeof repositoryLayer,
  typeof predeclaredOverrides
> = { overrides: predeclaredOverrides }
const explicitlyTypedRuntime = TestRuntime.make(repositoryLayer, explicitlyTypedOptions)
expectTypeOf<Awaited<typeof explicitlyTypedRuntime>['runtime']>().toEqualTypeOf<
  Runtime<Database | Repository>
>()

const incompatiblePredeclaredOverrides = [Layer.make(IncompatibleDatabase)] as const
const incompatiblePredeclaredOptions = { overrides: incompatiblePredeclaredOverrides }
// @ts-expect-error Predeclared same-tag overrides must preserve Layer compatibility checks.
void TestRuntime.make(completeLayer, incompatiblePredeclaredOptions)
// @ts-expect-error TestRuntime.use must preserve predeclared override validation.
void TestRuntime.use(completeLayer, incompatiblePredeclaredOptions, () => Result.ok(true))

const widenedOverrides: readonly Layer.Any[] = [Layer.make(IncompatibleDatabase)]
const widenedOptions = { overrides: widenedOverrides }
// @ts-expect-error Widened override arrays cannot prove same-tag compatibility.
void TestRuntime.make(completeLayer, widenedOptions)
const explicitlyWidenedOptions: TestRuntime.Options<typeof completeLayer> = {
  // @ts-expect-error The default options type cannot erase override tuple information.
  overrides: widenedOverrides
}
void explicitlyWidenedOptions

const uncheckedOverride: Layer.Any = Layer.make(IncompatibleDatabase)
const uncheckedRuntime = TestRuntime.make(completeLayer, {
  overrides: [uncheckedOverride] as const
})
expectTypeOf<Awaited<typeof uncheckedRuntime>['runtime']>().toEqualTypeOf<Runtime<any>>()
const completeRuntime = TestRuntime.make(completeLayer)
expectTypeOf<Awaited<typeof completeRuntime>>().toEqualTypeOf<TestRuntime<Database | Repository>>()

const controlledClock = new ClockTest(new Date('2026-01-01T00:00:00.000Z'))
const controlledLogger = new LoggerTest()
const controlledRandom = new RandomSeeded(42)
const uncheckedClockOverride: Layer.Any = incompatibleClockLayer
const uncheckedStandardRuntime = TestRuntime.make(incompatibleClockLayer, {
  overrides: [uncheckedClockOverride] as const,
  clock: controlledClock
})
expectTypeOf<Awaited<typeof uncheckedStandardRuntime>['runtime']>().toEqualTypeOf<Runtime<any>>()

const configuredRuntime = TestRuntime.make(Layer.make(Repository), {
  overrides: [databaseLayer],
  clock: controlledClock,
  logger: controlledLogger,
  random: controlledRandom
})

expectTypeOf<Awaited<typeof configuredRuntime>['runtime']>().toEqualTypeOf<
  Runtime<Database | Repository | Clock | Logger | Random>
>()
expectTypeOf<Awaited<typeof configuredRuntime>['clock']>().toEqualTypeOf<ClockTest>()
expectTypeOf<Awaited<typeof configuredRuntime>['logger']>().toEqualTypeOf<LoggerTest>()
expectTypeOf<Awaited<typeof configuredRuntime>['random']>().toEqualTypeOf<RandomSeeded>()
expectTypeOf<Awaited<typeof configuredRuntime>['observer']>().toMatchTypeOf<
  TestRuntime<any>['observer']
>()

const completeProgram = Effect.fn(async function* () {
  const repository = yield* Repository
  const clock = yield* Clock
  const logger = yield* Logger
  const random = yield* Random
  return Result.ok({ repository, clock, logger, random })
})

expectTypeOf<EffectRequirements<typeof completeProgram>>().toEqualTypeOf<
  Repository | Clock | Logger | Random
>()

const configuredResult = TestRuntime.use(
  Layer.make(Repository),
  {
    overrides: [databaseLayer],
    clock: controlledClock,
    logger: controlledLogger,
    random: controlledRandom
  },
  (test) => {
    test.logger.events.push({ level: 'debug', message: 'type test' })
    test.clock.advance(1)
    test.random.next()
    return test.run(completeProgram)
  }
)
expectTypeOf(configuredResult).toEqualTypeOf<Promise<Awaited<ReturnType<typeof completeProgram>>>>()

const executionLayer = Layer.succeed(Database, new Database())
const runWithResult = configuredRuntime.then((test) =>
  test.runWith(executionLayer, completeProgram)
)
expectTypeOf(runWithResult).toEqualTypeOf<Promise<Awaited<ReturnType<typeof completeProgram>>>>()

const options: TestRuntimeOptions<typeof completeLayer> = {
  observers: []
}
void options

// @ts-expect-error Repository requires Database when no override completes the Layer.
void TestRuntime.make(repositoryLayer)

void TestRuntime.make(completeLayer, {
  // @ts-expect-error The same-tag replacement does not implement Database's contract.
  overrides: [Layer.make(IncompatibleDatabase)]
})

// @ts-expect-error Standard Clock options must remain compatible with a same-tag base provider.
void TestRuntime.make(incompatibleClockLayer, { clock: controlledClock })
// @ts-expect-error Standard Logger options must remain compatible with a same-tag base provider.
void TestRuntime.make(incompatibleLoggerLayer, { logger: controlledLogger })
// @ts-expect-error Standard Random options must remain compatible with a same-tag base provider.
void TestRuntime.make(incompatibleRandomLayer, { random: controlledRandom })

const predeclaredClockOptions: TestRuntime.Options<typeof incompatibleClockLayer> = {
  // @ts-expect-error Predeclared standard options must retain same-tag compatibility checks.
  clock: controlledClock
}
void predeclaredClockOptions

// @ts-expect-error TestRuntime.use must validate standard option collisions too.
void TestRuntime.use(incompatibleClockLayer, { clock: controlledClock }, () => Result.ok(true))

const callbackResult = TestRuntime.use(
  Layer.merge(completeLayer, ClockTest.layer(), LoggerTest.layer(), RandomSeeded.layer(42)),
  (test) => test.run(completeProgram)
)
expectTypeOf(callbackResult).toEqualTypeOf<Promise<Awaited<ReturnType<typeof completeProgram>>>>()

void completeRuntime
void configuredRuntime
void configuredResult
void runWithResult
void callbackResult
