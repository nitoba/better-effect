import { Result } from 'better-result'

import {
  Effect,
  Layer,
  Runtime,
  Service,
  type RuntimeObserver as RuntimeObserverContract
} from 'better-effect'
import { Clock, Logger, Random } from 'better-effect/standard-services'
import {
  ClockTest,
  LoggerTest,
  RandomSeeded,
  RecordedRuntimeObserver,
  RuntimeObserver,
  TestRuntime,
  type RecordedRuntimeObserverSnapshot,
  type RuntimeObserverEvent
} from 'better-effect/testing'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Expect<Value extends true> = Value

const recorder = RecordedRuntimeObserver.make()
const composed: RuntimeObserverContract = RuntimeObserver.compose(recorder)
const snapshot = recorder.snapshot()

export type RecorderIsRuntimeObserver = Expect<
  Equal<RecordedRuntimeObserver extends RuntimeObserverContract ? true : false, true>
>
export type TimelineIsReadonly = Expect<
  Equal<RecordedRuntimeObserverSnapshot['timeline'], readonly RuntimeObserverEvent[]>
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

const packageUnionClockOptions: {} | { readonly clock: ClockTest } = { clock: new ClockTest() }
const packageUnionLoggerOptions: {} | { readonly logger: LoggerTest } = { logger: new LoggerTest() }
const packageUnionRandomOptions: {} | { readonly random: RandomSeeded } = {
  random: new RandomSeeded(42)
}
const packageUnionClockRuntime = TestRuntime.make(Layer.merge(), packageUnionClockOptions)
const packageUnionLoggerRuntime = TestRuntime.make(Layer.merge(), packageUnionLoggerOptions)
const packageUnionRandomRuntime = TestRuntime.make(Layer.merge(), packageUnionRandomOptions)
export type PackageUnionClockRuntime = Expect<
  Equal<Awaited<typeof packageUnionClockRuntime>['runtime'], Runtime<Clock>>
>
export type PackageUnionLoggerRuntime = Expect<
  Equal<Awaited<typeof packageUnionLoggerRuntime>['runtime'], Runtime<Logger>>
>
export type PackageUnionRandomRuntime = Expect<
  Equal<Awaited<typeof packageUnionRandomRuntime>['runtime'], Runtime<Random>>
>

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

void composed
void snapshot
void packageTestRuntime
void packageTestResult
void packageUnionClockRuntime
void packageUnionLoggerRuntime
void packageUnionRandomRuntime
