import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect, Layer, Service, type EffectRequirements } from '../../src'
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

const databaseLayer = Layer.make(Database)
const repositoryLayer = Layer.make(Repository)
const completeLayer = Layer.merge(databaseLayer, repositoryLayer)
const databaseTest = Layer.succeed(Database, new Database())

const typedOptions = {
  overrides: [databaseTest]
} satisfies TestRuntime.Options<typeof completeLayer>
void typedOptions

const completeRuntime = TestRuntime.make(completeLayer)
expectTypeOf<Awaited<typeof completeRuntime>>().toEqualTypeOf<TestRuntime<Database | Repository>>()

const controlledClock = new ClockTest(new Date('2026-01-01T00:00:00.000Z'))
const controlledLogger = new LoggerTest()
const controlledRandom = new RandomSeeded(42)
const configuredRuntime = TestRuntime.make(Layer.make(Repository), {
  overrides: [databaseLayer],
  clock: controlledClock,
  logger: controlledLogger,
  random: controlledRandom
})

expectTypeOf<Awaited<typeof configuredRuntime>['runtime']>().toMatchTypeOf<
  TestRuntime<Database | Repository | Clock | Logger | Random>['runtime']
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
