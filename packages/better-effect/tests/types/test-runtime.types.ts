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

const unionClockOptions: {} | { readonly clock: ClockTest } = { clock: controlledClock }
const unionLoggerOptions: {} | { readonly logger: LoggerTest } = { logger: controlledLogger }
const unionRandomOptions: {} | { readonly random: RandomSeeded } = { random: controlledRandom }
type DisjointStandardOptions =
  | { readonly clock: ClockTest }
  | { readonly logger: LoggerTest }
  | { readonly random: RandomSeeded }
type EmptyStandardOptions =
  | {}
  | { readonly clock: ClockTest }
  | { readonly logger: LoggerTest }
  | { readonly random: RandomSeeded }
type GuaranteedClockOptions =
  | { readonly clock: ClockTest; readonly logger: LoggerTest }
  | { readonly clock: ClockTest; readonly random: RandomSeeded }
type GuaranteedLoggerOptions =
  | { readonly logger: LoggerTest; readonly clock: ClockTest }
  | { readonly logger: LoggerTest; readonly random: RandomSeeded }
type GuaranteedRandomOptions =
  | { readonly random: RandomSeeded; readonly clock: ClockTest }
  | { readonly random: RandomSeeded; readonly logger: LoggerTest }

declare const disjointOptions: DisjointStandardOptions
declare const emptyOptions: {}
declare const emptyUnionOptions: EmptyStandardOptions
declare const neverOptions: never
declare const guaranteedClockOptions: GuaranteedClockOptions
declare const guaranteedLoggerOptions: GuaranteedLoggerOptions
declare const guaranteedRandomOptions: GuaranteedRandomOptions

const explicitClockLayer = ClockTest.layer()
const explicitLoggerLayer = LoggerTest.layer()
const explicitRandomLayer = RandomSeeded.layer(42)
type EmptyOverrideOptions =
  | { readonly overrides: readonly [] }
  | { readonly overrides: readonly [typeof explicitClockLayer] }
type DisjointOverrideOptions =
  | { readonly overrides: readonly [typeof explicitClockLayer] }
  | { readonly overrides: readonly [typeof explicitLoggerLayer] }
  | { readonly overrides: readonly [typeof explicitRandomLayer] }
type SharedOverrideOptions =
  | { readonly overrides: readonly [typeof explicitClockLayer, typeof explicitLoggerLayer] }
  | { readonly overrides: readonly [typeof explicitClockLayer, typeof explicitRandomLayer] }
type InvalidOverrideOptions =
  | { readonly overrides: readonly [] }
  | { readonly overrides: readonly [typeof incompatibleClockLayer] }

declare const emptyOverrideOptions: EmptyOverrideOptions
declare const disjointOverrideOptions: DisjointOverrideOptions
declare const sharedOverrideOptions: SharedOverrideOptions
declare const invalidOverrideOptions: InvalidOverrideOptions

const unionClockRuntime = TestRuntime.make(Layer.merge(), unionClockOptions)
const unionLoggerRuntime = TestRuntime.make(Layer.merge(), unionLoggerOptions)
const unionRandomRuntime = TestRuntime.make(Layer.merge(), unionRandomOptions)
const disjointRuntime = TestRuntime.make(Layer.merge(), disjointOptions)
const emptyRuntime = TestRuntime.make(Layer.merge(), emptyOptions)
const emptyUnionRuntime = TestRuntime.make(Layer.merge(), emptyUnionOptions)
const neverRuntime = TestRuntime.make(Layer.merge(), neverOptions)
const guaranteedClockRuntime = TestRuntime.make(Layer.merge(), guaranteedClockOptions)
const guaranteedLoggerRuntime = TestRuntime.make(Layer.merge(), guaranteedLoggerOptions)
const guaranteedRandomRuntime = TestRuntime.make(Layer.merge(), guaranteedRandomOptions)
const emptyOverrideRuntime = TestRuntime.make(Layer.merge(), emptyOverrideOptions)
const disjointOverrideRuntime = TestRuntime.make(Layer.merge(), disjointOverrideOptions)
const sharedOverrideRuntime = TestRuntime.make(Layer.merge(), sharedOverrideOptions)
expectTypeOf<Awaited<typeof unionClockRuntime>['runtime']>().toEqualTypeOf<Runtime<never>>()
expectTypeOf<Awaited<typeof unionLoggerRuntime>['runtime']>().toEqualTypeOf<Runtime<never>>()
expectTypeOf<Awaited<typeof unionRandomRuntime>['runtime']>().toEqualTypeOf<Runtime<never>>()
expectTypeOf<Awaited<typeof disjointRuntime>['runtime']>().toEqualTypeOf<Runtime<never>>()
expectTypeOf<Awaited<typeof emptyRuntime>['runtime']>().toEqualTypeOf<Runtime<never>>()
expectTypeOf<Awaited<typeof emptyUnionRuntime>['runtime']>().toEqualTypeOf<Runtime<never>>()
expectTypeOf<Awaited<typeof neverRuntime>['runtime']>().toEqualTypeOf<Runtime<never>>()
expectTypeOf<Awaited<typeof guaranteedClockRuntime>['runtime']>().toEqualTypeOf<Runtime<Clock>>()
expectTypeOf<Awaited<typeof guaranteedLoggerRuntime>['runtime']>().toEqualTypeOf<Runtime<Logger>>()
expectTypeOf<Awaited<typeof guaranteedRandomRuntime>['runtime']>().toEqualTypeOf<Runtime<Random>>()
expectTypeOf<Awaited<typeof emptyOverrideRuntime>['runtime']>().toEqualTypeOf<Runtime<never>>()
expectTypeOf<Awaited<typeof disjointOverrideRuntime>['runtime']>().toEqualTypeOf<Runtime<never>>()
expectTypeOf<Awaited<typeof sharedOverrideRuntime>['runtime']>().toEqualTypeOf<Runtime<Clock>>()

const directEmptyOverride = Layer.override(Layer.merge(), ...emptyOverrideOptions.overrides)
const directDisjointOverride = Layer.override(Layer.merge(), ...disjointOverrideOptions.overrides)
const directSharedOverride = Layer.override(Layer.merge(), ...sharedOverrideOptions.overrides)
expectTypeOf<Layer.Provided<typeof directEmptyOverride>>().toBeNever()
expectTypeOf<Layer.Provided<typeof directDisjointOverride>>().toBeNever()
expectTypeOf<Layer.Provided<typeof directSharedOverride>>().toEqualTypeOf<Clock>()
const chainedOverride = Layer.override(directEmptyOverride, LoggerTest.layer())
expectTypeOf<Layer.Provided<typeof chainedOverride>>().toEqualTypeOf<Logger>()
// @ts-expect-error Possible providers from an earlier override branch remain collision-checked.
Layer.override(directEmptyOverride, incompatibleClockLayer)

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

const standardProgram = Effect.fn(async function* () {
  const clock = yield* Clock
  const logger = yield* Logger
  const random = yield* Random
  return Result.ok({ clock, logger, random })
})

const requiresClockProgram = Effect.fn(async function* () {
  const clock = yield* Clock
  return Result.ok(clock.now())
})

const requiresLoggerProgram = Effect.fn(async function* () {
  const logger = yield* Logger
  return Result.ok(logger)
})

const requiresRandomProgram = Effect.fn(async function* () {
  const random = yield* Random
  return Result.ok(random)
})

const disjointMakeRun = disjointRuntime.then((test) => {
  // @ts-expect-error A disjoint options union does not guarantee standard services.
  return test.run(standardProgram)
})
const emptyMakeRun = emptyRuntime.then((test) => {
  // @ts-expect-error Empty options do not provide standard services.
  return test.run(standardProgram)
})
const emptyUnionMakeRun = emptyUnionRuntime.then((test) => {
  // @ts-expect-error An empty options arm does not guarantee standard services.
  return test.run(standardProgram)
})
const neverMakeRun = neverRuntime.then((test) => {
  // @ts-expect-error A never options union cannot provide standard services.
  return test.run(standardProgram)
})
const emptyOverrideMakeRun = emptyOverrideRuntime.then((test) => {
  // @ts-expect-error An empty override arm does not guarantee Clock.
  return test.run(requiresClockProgram)
})
const disjointOverrideMakeRun = disjointOverrideRuntime.then((test) => {
  // @ts-expect-error Disjoint override arms do not guarantee Clock.
  return test.run(requiresClockProgram)
})
const sharedOverrideMakeRun = sharedOverrideRuntime.then((test) => test.run(requiresClockProgram))
const guaranteedLoggerMakeRun = guaranteedLoggerRuntime.then((test) =>
  test.run(requiresLoggerProgram)
)
const guaranteedRandomMakeRun = guaranteedRandomRuntime.then((test) =>
  test.run(requiresRandomProgram)
)

const disjointUseResult = TestRuntime.use(Layer.merge(), disjointOptions, (test) => {
  expectTypeOf(test.runtime).toEqualTypeOf<Runtime<never>>()
  // @ts-expect-error A disjoint options union does not guarantee standard services.
  return test.run(standardProgram)
})
const emptyUseResult = TestRuntime.use(Layer.merge(), emptyOptions, (test) => {
  expectTypeOf(test.runtime).toEqualTypeOf<Runtime<never>>()
  // @ts-expect-error Empty options do not provide standard services.
  return test.run(standardProgram)
})
const emptyUnionUseResult = TestRuntime.use(Layer.merge(), emptyUnionOptions, (test) => {
  expectTypeOf(test.runtime).toEqualTypeOf<Runtime<never>>()
  // @ts-expect-error An empty options arm does not guarantee standard services.
  return test.run(standardProgram)
})
const neverUseResult = TestRuntime.use(Layer.merge(), neverOptions, (test) => {
  expectTypeOf(test.runtime).toEqualTypeOf<Runtime<never>>()
  // @ts-expect-error A never options union cannot provide standard services.
  return test.run(standardProgram)
})
const guaranteedClockUseResult = TestRuntime.use(Layer.merge(), guaranteedClockOptions, (test) => {
  expectTypeOf(test.runtime).toEqualTypeOf<Runtime<Clock>>()
  return test.run(requiresClockProgram)
})
const emptyOverrideUseResult = TestRuntime.use(Layer.merge(), emptyOverrideOptions, (test) => {
  expectTypeOf(test.runtime).toEqualTypeOf<Runtime<never>>()
  // @ts-expect-error An empty override arm does not guarantee Clock.
  return test.run(requiresClockProgram)
})
const disjointOverrideUseResult = TestRuntime.use(
  Layer.merge(),
  disjointOverrideOptions,
  (test) => {
    expectTypeOf(test.runtime).toEqualTypeOf<Runtime<never>>()
    // @ts-expect-error Disjoint override arms do not guarantee Clock.
    return test.run(requiresClockProgram)
  }
)
const sharedOverrideUseResult = TestRuntime.use(Layer.merge(), sharedOverrideOptions, (test) => {
  expectTypeOf(test.runtime).toEqualTypeOf<Runtime<Clock>>()
  return test.run(requiresClockProgram)
})
const guaranteedLoggerUseResult = TestRuntime.use(
  Layer.merge(),
  guaranteedLoggerOptions,
  (test) => {
    expectTypeOf(test.runtime).toEqualTypeOf<Runtime<Logger>>()
    return test.run(requiresLoggerProgram)
  }
)
const guaranteedRandomUseResult = TestRuntime.use(
  Layer.merge(),
  guaranteedRandomOptions,
  (test) => {
    expectTypeOf(test.runtime).toEqualTypeOf<Runtime<Random>>()
    return test.run(requiresRandomProgram)
  }
)

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
// @ts-expect-error Union-shaped Clock options must remain compatible with a same-tag base provider.
void TestRuntime.make(incompatibleClockLayer, unionClockOptions)
// @ts-expect-error Union-shaped Logger options must remain compatible with a same-tag base provider.
void TestRuntime.make(incompatibleLoggerLayer, unionLoggerOptions)
// @ts-expect-error Union-shaped Random options must remain compatible with a same-tag base provider.
void TestRuntime.make(incompatibleRandomLayer, unionRandomOptions)

const predeclaredClockOptions: TestRuntime.Options<typeof incompatibleClockLayer> = {
  // @ts-expect-error Predeclared standard options must retain same-tag compatibility checks.
  clock: controlledClock
}
void predeclaredClockOptions

// @ts-expect-error TestRuntime.use must validate standard option collisions too.
void TestRuntime.use(incompatibleClockLayer, { clock: controlledClock }, () => Result.ok(true))
// @ts-expect-error Union-shaped Clock options must remain compatible with a same-tag base provider.
void TestRuntime.use(incompatibleClockLayer, unionClockOptions, () => Result.ok(true))
// @ts-expect-error Union-shaped Logger options must remain compatible with a same-tag base provider.
void TestRuntime.use(incompatibleLoggerLayer, unionLoggerOptions, () => Result.ok(true))
// @ts-expect-error Union-shaped Random options must remain compatible with a same-tag base provider.
void TestRuntime.use(incompatibleRandomLayer, unionRandomOptions, () => Result.ok(true))
// @ts-expect-error Every possible explicit override arm must pass collision validation.
void TestRuntime.make(ClockTest.layer(), invalidOverrideOptions)
// @ts-expect-error TestRuntime.use must validate every possible explicit override arm.
void TestRuntime.use(ClockTest.layer(), invalidOverrideOptions, () => Result.ok(true))
// @ts-expect-error Every possible explicit override arm must pass Layer collision validation.
Layer.override(ClockTest.layer(), ...invalidOverrideOptions.overrides)
// @ts-expect-error A concrete incompatible override must fail directly too.
Layer.override(ClockTest.layer(), incompatibleClockLayer)

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
void unionClockRuntime
void unionLoggerRuntime
void unionRandomRuntime
void disjointMakeRun
void emptyMakeRun
void emptyUnionMakeRun
void neverMakeRun
void disjointUseResult
void emptyUseResult
void emptyUnionUseResult
void neverUseResult
void guaranteedClockUseResult
void emptyOverrideMakeRun
void disjointOverrideMakeRun
void sharedOverrideMakeRun
void emptyOverrideUseResult
void disjointOverrideUseResult
void sharedOverrideUseResult
void guaranteedLoggerMakeRun
void guaranteedRandomMakeRun
void guaranteedLoggerUseResult
void guaranteedRandomUseResult
void directEmptyOverride
void directDisjointOverride
void directSharedOverride
