import { Result } from 'better-result'

import {
  Effect,
  Layer,
  Runtime,
  Service,
  type RuntimeObserver as RuntimeObserverContract
} from 'better-effect'
import { Clock, IdGenerator, Logger, Random } from 'better-effect/standard-services'
import {
  ClockTest,
  IdGeneratorTest,
  LoggerTest,
  RandomSeeded,
  RecordedRuntimeObserver,
  RuntimeGraphObserver,
  RuntimeObserver,
  TestRuntime,
  type RecordedRuntimeObserverSnapshot,
  type RuntimeGraphEdge,
  type RuntimeGraphNode,
  type RuntimeGraphObserverOptions,
  type RuntimeGraphSnapshot,
  type RuntimeObserverEvent
} from 'better-effect/testing'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Expect<Value extends true> = Value

const expectExactType = <Actual, Expected>(
  value: Equal<Actual, Expected> extends true ? true : never
): void => {
  void value
}

const recorder = RecordedRuntimeObserver.make()
const composed: RuntimeObserverContract = RuntimeObserver.compose(recorder)
const snapshot = recorder.snapshot()
const graph = RuntimeGraphObserver.make({ includeFailures: true, rootLabel: 'Runtime' })
const graphSnapshot = graph.toJSON()
const graphOptions: RuntimeGraphObserverOptions = { rootLabel: 'Runtime' }

export type RecorderIsRuntimeObserver = Expect<
  Equal<RecordedRuntimeObserver extends RuntimeObserverContract ? true : false, true>
>
export type GraphObserverIsRuntimeObserver = Expect<
  Equal<RuntimeGraphObserver extends RuntimeObserverContract ? true : false, true>
>
export type TimelineIsReadonly = Expect<
  Equal<RecordedRuntimeObserverSnapshot['timeline'], readonly RuntimeObserverEvent[]>
>
export type GraphSnapshotIsReadonly = Expect<
  Equal<RuntimeGraphSnapshot['nodes'], readonly RuntimeGraphNode[]>
>
export type GraphEdgesAreReadonly = Expect<
  Equal<RuntimeGraphSnapshot['edges'], readonly RuntimeGraphEdge[]>
>

class PackageTestingService extends Service<PackageTestingService>()('PackageTestingService') {}

class PackageIncompatibleTestingService extends Service<PackageIncompatibleTestingService>()(
  'PackageTestingService'
) {
  write(): void {}
}

class PackageClockCollision extends Service<PackageClockCollision>()('Clock') {
  now(): string {
    return ''
  }

  sleep(): Promise<void> {
    return Promise.resolve()
  }
}

class PackageLoggerCollision extends Service<PackageLoggerCollision>()('Logger') {
  log(message: string): void {
    void message
  }
}

class PackageRandomCollision extends Service<PackageRandomCollision>()('Random') {
  next(): string {
    return ''
  }
}

const packageTestingLayer = Layer.make(PackageTestingService)
const packageIncompatibleTestingLayer = Layer.make(PackageIncompatibleTestingService)
const packageClockCollisionLayer = Layer.make(PackageClockCollision)
const packageLoggerCollisionLayer = Layer.make(PackageLoggerCollision)
const packageRandomCollisionLayer = Layer.make(PackageRandomCollision)
const packageTestingProgram = Effect.fn(async function* () {
  const service = yield* PackageTestingService
  const clock = yield* Clock
  const logger = yield* Logger
  const random = yield* Random

  logger.info('package smoke', { sample: random.nextInt(10) })
  return Result.ok({ service, now: clock.now() })
})
const packageStandardProgram = Effect.fn(async function* () {
  const clock = yield* Clock
  const logger = yield* Logger
  const random = yield* Random

  logger.info('package standard smoke', { sample: random.nextInt(10) })
  return Result.ok({ clock, logger, random })
})
const packageClockProgram = Effect.fn(async function* () {
  const clock = yield* Clock
  return Result.ok(clock.now())
})
const packageLoggerProgram = Effect.fn(async function* () {
  const logger = yield* Logger
  return Result.ok(logger)
})
const packageRandomProgram = Effect.fn(async function* () {
  const random = yield* Random
  return Result.ok(random)
})
const packageIdGeneratorProgram = Effect.fn(async function* () {
  const ids = yield* IdGenerator
  return Result.ok(ids.next())
})
const packageIdGenerator = new IdGeneratorTest(['package-id'])
const packageIdGeneratorRuntime = TestRuntime.make(Layer.merge(), {
  idGenerator: packageIdGenerator
})
export type PackageIdGeneratorSuccess = Expect<
  Equal<Effect.Success<typeof packageIdGeneratorProgram>, string>
>
export type PackageIdGeneratorRuntime = Expect<
  Equal<Awaited<typeof packageIdGeneratorRuntime>['runtime'], Runtime<IdGenerator>>
>

const packageTestRuntime = TestRuntime.make(packageTestingLayer, {
  clock: new ClockTest(),
  logger: new LoggerTest(),
  random: new RandomSeeded(42)
})
const packageTestResult = TestRuntime.use(
  packageTestingLayer,
  {
    clock: new ClockTest(),
    logger: new LoggerTest(),
    random: new RandomSeeded(42)
  },
  (test) => test.run(packageTestingProgram)
)

export type PackageTestRuntime = Expect<
  Equal<
    Awaited<typeof packageTestRuntime>['runtime'],
    Runtime<PackageTestingService | Clock | Logger | Random>
  >
>
export type PackageTestResult = Expect<
  Equal<Awaited<typeof packageTestResult>, Awaited<ReturnType<typeof packageTestingProgram>>>
>

const packageReplacement = Layer.succeed(PackageTestingService, new PackageTestingService())
const packagePredeclaredOverrides = [packageReplacement] as const
const packagePredeclaredOptions = {
  overrides: packagePredeclaredOverrides
} satisfies TestRuntime.Options<typeof packageTestingLayer, typeof packagePredeclaredOverrides>
const packagePredeclaredRuntime = TestRuntime.make(packageTestingLayer, packagePredeclaredOptions)
export type PackagePredeclaredRuntime = Expect<
  Equal<Awaited<typeof packagePredeclaredRuntime>['runtime'], Runtime<PackageTestingService>>
>

const packageIncompatibleOptions = {
  overrides: [packageIncompatibleTestingLayer] as const
}
// @ts-expect-error predeclared same-tag overrides must preserve Layer compatibility checks
void TestRuntime.make(packageTestingLayer, packageIncompatibleOptions)

const packageWidenedOverrides: readonly Layer.Any[] = [packageIncompatibleTestingLayer]
const packageWidenedOptions = { overrides: packageWidenedOverrides }
// @ts-expect-error widened override arrays cannot prove same-tag compatibility
void TestRuntime.make(packageTestingLayer, packageWidenedOptions)
const packageExplicitlyWidenedOptions: TestRuntime.Options<typeof packageTestingLayer> = {
  // @ts-expect-error the default options type cannot erase override tuple information
  overrides: packageWidenedOverrides
}
void packageExplicitlyWidenedOptions

const packageUncheckedOverride: Layer.Any = packageIncompatibleTestingLayer
const packageUncheckedRuntime = TestRuntime.make(packageTestingLayer, {
  overrides: [packageUncheckedOverride] as const
})
export type PackageUncheckedRuntime = Expect<
  Equal<Awaited<typeof packageUncheckedRuntime>['runtime'], Runtime<any>>
>

const packageClockOptions: TestRuntime.Options<typeof packageClockCollisionLayer> = {
  // @ts-expect-error predeclared standard options must preserve same-tag compatibility
  clock: new ClockTest()
}
void packageClockOptions

type PackageDisjointStandardOptions =
  | { readonly clock: ClockTest }
  | { readonly logger: LoggerTest }
  | { readonly random: RandomSeeded }
type PackageEmptyStandardOptions =
  | {}
  | { readonly clock: ClockTest }
  | { readonly logger: LoggerTest }
  | { readonly random: RandomSeeded }
type PackageGuaranteedClockOptions =
  | { readonly clock: ClockTest; readonly logger: LoggerTest }
  | { readonly clock: ClockTest; readonly random: RandomSeeded }
type PackageGuaranteedLoggerOptions =
  | { readonly logger: LoggerTest; readonly clock: ClockTest }
  | { readonly logger: LoggerTest; readonly random: RandomSeeded }
type PackageGuaranteedRandomOptions =
  | { readonly random: RandomSeeded; readonly clock: ClockTest }
  | { readonly random: RandomSeeded; readonly logger: LoggerTest }

declare const packageUnionClockOptions: {} | { readonly clock: ClockTest }
declare const packageUnionLoggerOptions: {} | { readonly logger: LoggerTest }
declare const packageUnionRandomOptions: {} | { readonly random: RandomSeeded }
declare const packageDisjointOptions: PackageDisjointStandardOptions
declare const packageEmptyOptions: {}
declare const packageEmptyUnionOptions: PackageEmptyStandardOptions
declare const packageNeverOptions: never
declare const packageGuaranteedClockOptions: PackageGuaranteedClockOptions
declare const packageGuaranteedLoggerOptions: PackageGuaranteedLoggerOptions
declare const packageGuaranteedRandomOptions: PackageGuaranteedRandomOptions

type PackageEmptyOverrideOptions =
  | { readonly overrides: readonly [] }
  | { readonly overrides: readonly [ReturnType<typeof ClockTest.layer>] }
type PackageDisjointOverrideOptions =
  | { readonly overrides: readonly [ReturnType<typeof ClockTest.layer>] }
  | { readonly overrides: readonly [ReturnType<typeof LoggerTest.layer>] }
  | { readonly overrides: readonly [ReturnType<typeof RandomSeeded.layer>] }
type PackageSharedOverrideOptions =
  | {
      readonly overrides: readonly [
        ReturnType<typeof ClockTest.layer>,
        ReturnType<typeof LoggerTest.layer>
      ]
    }
  | {
      readonly overrides: readonly [
        ReturnType<typeof ClockTest.layer>,
        ReturnType<typeof RandomSeeded.layer>
      ]
    }
type PackageInvalidOverrideOptions =
  | { readonly overrides: readonly [] }
  | { readonly overrides: readonly [ReturnType<typeof ClockTest.layer>] }

declare const packageEmptyOverrideOptions: PackageEmptyOverrideOptions
declare const packageDisjointOverrideOptions: PackageDisjointOverrideOptions
declare const packageSharedOverrideOptions: PackageSharedOverrideOptions
declare const packageInvalidOverrideOptions: PackageInvalidOverrideOptions

const packageUnionClockRuntime = TestRuntime.make(Layer.merge(), packageUnionClockOptions)
const packageUnionLoggerRuntime = TestRuntime.make(Layer.merge(), packageUnionLoggerOptions)
const packageUnionRandomRuntime = TestRuntime.make(Layer.merge(), packageUnionRandomOptions)
const packageDisjointRuntime = TestRuntime.make(Layer.merge(), packageDisjointOptions)
const packageEmptyRuntime = TestRuntime.make(Layer.merge(), packageEmptyOptions)
const packageEmptyUnionRuntime = TestRuntime.make(Layer.merge(), packageEmptyUnionOptions)
const packageNeverRuntime = TestRuntime.make(Layer.merge(), packageNeverOptions)
const packageGuaranteedClockRuntime = TestRuntime.make(Layer.merge(), packageGuaranteedClockOptions)
const packageGuaranteedLoggerRuntime = TestRuntime.make(
  Layer.merge(),
  packageGuaranteedLoggerOptions
)
const packageGuaranteedRandomRuntime = TestRuntime.make(
  Layer.merge(),
  packageGuaranteedRandomOptions
)
const packageEmptyOverrideRuntime = TestRuntime.make(Layer.merge(), packageEmptyOverrideOptions)
const packageDisjointOverrideRuntime = TestRuntime.make(
  Layer.merge(),
  packageDisjointOverrideOptions
)
const packageSharedOverrideRuntime = TestRuntime.make(Layer.merge(), packageSharedOverrideOptions)
const packageDirectEmptyOverride = Layer.override(
  Layer.merge(),
  ...packageEmptyOverrideOptions.overrides
)
const packageDirectDisjointOverride = Layer.override(
  Layer.merge(),
  ...packageDisjointOverrideOptions.overrides
)
const packageDirectSharedOverride = Layer.override(
  Layer.merge(),
  ...packageSharedOverrideOptions.overrides
)
export type PackageUnionClockRuntime = Expect<
  Equal<Awaited<typeof packageUnionClockRuntime>['runtime'], Runtime<never>>
>
export type PackageUnionLoggerRuntime = Expect<
  Equal<Awaited<typeof packageUnionLoggerRuntime>['runtime'], Runtime<never>>
>
export type PackageUnionRandomRuntime = Expect<
  Equal<Awaited<typeof packageUnionRandomRuntime>['runtime'], Runtime<never>>
>
export type PackageDisjointRuntime = Expect<
  Equal<Awaited<typeof packageDisjointRuntime>['runtime'], Runtime<never>>
>
export type PackageEmptyRuntime = Expect<
  Equal<Awaited<typeof packageEmptyRuntime>['runtime'], Runtime<never>>
>
export type PackageEmptyUnionRuntime = Expect<
  Equal<Awaited<typeof packageEmptyUnionRuntime>['runtime'], Runtime<never>>
>
export type PackageNeverRuntime = Expect<
  Equal<Awaited<typeof packageNeverRuntime>['runtime'], Runtime<never>>
>
export type PackageGuaranteedClockRuntime = Expect<
  Equal<Awaited<typeof packageGuaranteedClockRuntime>['runtime'], Runtime<Clock>>
>
export type PackageGuaranteedLoggerRuntime = Expect<
  Equal<Awaited<typeof packageGuaranteedLoggerRuntime>['runtime'], Runtime<Logger>>
>
export type PackageGuaranteedRandomRuntime = Expect<
  Equal<Awaited<typeof packageGuaranteedRandomRuntime>['runtime'], Runtime<Random>>
>
export type PackageEmptyOverrideRuntime = Expect<
  Equal<Awaited<typeof packageEmptyOverrideRuntime>['runtime'], Runtime<never>>
>
export type PackageDisjointOverrideRuntime = Expect<
  Equal<Awaited<typeof packageDisjointOverrideRuntime>['runtime'], Runtime<never>>
>
export type PackageSharedOverrideRuntime = Expect<
  Equal<Awaited<typeof packageSharedOverrideRuntime>['runtime'], Runtime<Clock>>
>
export type PackageDirectEmptyOverride = Expect<
  Equal<Layer.Provided<typeof packageDirectEmptyOverride>, never>
>
export type PackageDirectDisjointOverride = Expect<
  Equal<Layer.Provided<typeof packageDirectDisjointOverride>, never>
>
export type PackageDirectSharedOverride = Expect<
  Equal<Layer.Provided<typeof packageDirectSharedOverride>, Clock>
>

const packageDisjointUse = TestRuntime.use(Layer.merge(), packageDisjointOptions, (test) => {
  expectExactType<typeof test.runtime, Runtime<never>>(true)
  // @ts-expect-error A disjoint options union does not guarantee standard services.
  return test.run(packageStandardProgram)
})
const packageEmptyUse = TestRuntime.use(Layer.merge(), packageEmptyOptions, (test) => {
  expectExactType<typeof test.runtime, Runtime<never>>(true)
  // @ts-expect-error Empty options do not provide standard services.
  return test.run(packageStandardProgram)
})
const packageEmptyUnionUse = TestRuntime.use(Layer.merge(), packageEmptyUnionOptions, (test) => {
  expectExactType<typeof test.runtime, Runtime<never>>(true)
  // @ts-expect-error An empty options arm does not guarantee standard services.
  return test.run(packageStandardProgram)
})
const packageNeverUse = TestRuntime.use(Layer.merge(), packageNeverOptions, (test) => {
  expectExactType<typeof test.runtime, Runtime<never>>(true)
  // @ts-expect-error A never options union cannot provide standard services.
  return test.run(packageStandardProgram)
})
const packageGuaranteedClockUse = TestRuntime.use(
  Layer.merge(),
  packageGuaranteedClockOptions,
  (test) => {
    expectExactType<typeof test.runtime, Runtime<Clock>>(true)
    return test.run(packageClockProgram)
  }
)
const packageGuaranteedLoggerUse = TestRuntime.use(
  Layer.merge(),
  packageGuaranteedLoggerOptions,
  (test) => {
    expectExactType<typeof test.runtime, Runtime<Logger>>(true)
    return test.run(packageLoggerProgram)
  }
)
const packageGuaranteedRandomUse = TestRuntime.use(
  Layer.merge(),
  packageGuaranteedRandomOptions,
  (test) => {
    expectExactType<typeof test.runtime, Runtime<Random>>(true)
    return test.run(packageRandomProgram)
  }
)
const packageEmptyOverrideUse = TestRuntime.use(
  Layer.merge(),
  packageEmptyOverrideOptions,
  (test) => {
    expectExactType<typeof test.runtime, Runtime<never>>(true)
    // @ts-expect-error An empty override arm does not guarantee Clock.
    return test.run(packageClockProgram)
  }
)
const packageDisjointOverrideUse = TestRuntime.use(
  Layer.merge(),
  packageDisjointOverrideOptions,
  (test) => {
    expectExactType<typeof test.runtime, Runtime<never>>(true)
    // @ts-expect-error Disjoint override arms do not guarantee Clock.
    return test.run(packageClockProgram)
  }
)
const packageSharedOverrideUse = TestRuntime.use(
  Layer.merge(),
  packageSharedOverrideOptions,
  (test) => {
    expectExactType<typeof test.runtime, Runtime<Clock>>(true)
    return test.run(packageClockProgram)
  }
)

// @ts-expect-error standard Clock options must remain compatible with a same-tag base provider
void TestRuntime.make(packageClockCollisionLayer, { clock: new ClockTest() })
// @ts-expect-error standard Logger options must remain compatible with a same-tag base provider
void TestRuntime.make(packageLoggerCollisionLayer, { logger: new LoggerTest() })
// @ts-expect-error standard Random options must remain compatible with a same-tag base provider
void TestRuntime.make(packageRandomCollisionLayer, { random: new RandomSeeded(42) })
// @ts-expect-error Union-shaped Clock options must remain compatible with a same-tag base provider
void TestRuntime.make(packageClockCollisionLayer, packageUnionClockOptions)
// @ts-expect-error Union-shaped Logger options must remain compatible with a same-tag base provider
void TestRuntime.make(packageLoggerCollisionLayer, packageUnionLoggerOptions)
// @ts-expect-error Union-shaped Random options must remain compatible with a same-tag base provider
void TestRuntime.make(packageRandomCollisionLayer, packageUnionRandomOptions)
// @ts-expect-error TestRuntime.use must validate standard option collisions too
void TestRuntime.use(packageClockCollisionLayer, { clock: new ClockTest() }, () => Result.ok(true))
// @ts-expect-error Union-shaped Clock options must remain compatible with a same-tag base provider
void TestRuntime.use(packageClockCollisionLayer, packageUnionClockOptions, () => Result.ok(true))
// @ts-expect-error Union-shaped Logger options must remain compatible with a same-tag base provider
void TestRuntime.use(packageLoggerCollisionLayer, packageUnionLoggerOptions, () => Result.ok(true))
// @ts-expect-error Union-shaped Random options must remain compatible with a same-tag base provider
void TestRuntime.use(packageRandomCollisionLayer, packageUnionRandomOptions, () => Result.ok(true))
// @ts-expect-error Every possible explicit override arm must pass collision validation
void TestRuntime.make(packageClockCollisionLayer, packageInvalidOverrideOptions)
// @ts-expect-error TestRuntime.use must validate every possible explicit override arm
void TestRuntime.use(packageClockCollisionLayer, packageInvalidOverrideOptions, () =>
  Result.ok(true)
)
// @ts-expect-error Layer.override must validate every possible explicit override arm
Layer.override(packageClockCollisionLayer, ...packageInvalidOverrideOptions.overrides)

void composed
void snapshot
void graph
void graphSnapshot
void graphOptions
void packageTestRuntime
void packageTestResult
void packageIdGeneratorRuntime
void packageIdGeneratorProgram
void packageUnionClockRuntime
void packageUnionLoggerRuntime
void packageUnionRandomRuntime
void packageDisjointRuntime
void packageEmptyRuntime
void packageEmptyUnionRuntime
void packageNeverRuntime
void packageGuaranteedClockRuntime
void packageGuaranteedLoggerRuntime
void packageGuaranteedRandomRuntime
void packageEmptyOverrideRuntime
void packageDisjointOverrideRuntime
void packageSharedOverrideRuntime
void packageDisjointUse
void packageEmptyUse
void packageEmptyUnionUse
void packageNeverUse
void packageGuaranteedClockUse
void packageGuaranteedLoggerUse
void packageGuaranteedRandomUse
void packageEmptyOverrideUse
void packageDisjointOverrideUse
void packageSharedOverrideUse
