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

const packageTestingLayer = Layer.make(PackageTestingService)
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

void composed
void snapshot
void packageTestRuntime
void packageTestResult
