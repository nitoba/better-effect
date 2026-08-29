import type { ServiceContract } from 'better-effect'

import {
  Clock,
  ClockLive,
  ClockTest,
  type ClockSleepOptions,
  type ClockTestRunAllOptions,
  Config,
  ConfigLive,
  CurrentRequest,
  Logger,
  LoggerTest,
  Random,
  RandomSeeded
} from 'better-effect/standard-services'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Expect<Value extends true> = Value

export type ClockTag = Expect<Equal<typeof Clock.serviceTag, 'Clock'>>
export type RandomTag = Expect<Equal<typeof Random.serviceTag, 'Random'>>
export type LoggerTag = Expect<Equal<typeof Logger.serviceTag, 'Logger'>>
export type RequestTag = Expect<Equal<typeof CurrentRequest.serviceTag, 'CurrentRequest'>>
export type ConfigTag = Expect<Equal<typeof Config.serviceTag, 'Config'>>
export type ClockProvider = Expect<Equal<typeof ClockLive extends object ? true : false, true>>
export type ConfigProvider = Expect<Equal<typeof ConfigLive extends object ? true : false, true>>
export type ClockContract = Expect<
  Equal<Pick<ClockTest, 'now' | 'sleep'> extends Pick<Clock, 'now' | 'sleep'> ? true : false, true>
>
export type ClockSleepContract = Expect<
  Equal<Parameters<Clock['sleep']>[1], ClockSleepOptions | undefined>
>
export type ClockAdvanceToNextResult = Expect<
  Equal<ReturnType<ClockTest['advanceToNext']>, boolean>
>
export type ClockRunAllResult = Expect<Equal<ReturnType<ClockTest['runAll']>, Promise<number>>>

const legacyClock = {
  now: () => new Date(),
  sleep: async (_milliseconds: number) => {}
} satisfies ServiceContract<Clock>

const runAllOptions: ClockTestRunAllOptions = { maxSteps: 10 }
declare const clockTest: ClockTest
void clockTest.runAll()
void clockTest.runAll(runAllOptions)
// @ts-expect-error ClockTest.runAll accepts object options, not a numeric shorthand.
void clockTest.runAll(10)
// @ts-expect-error pendingSleeps is a readonly count.
clockTest.pendingSleeps = 0
void legacyClock
void runAllOptions
export type RandomContract = Expect<
  Equal<
    Pick<RandomSeeded, 'next' | 'nextInt'> extends Pick<Random, 'next' | 'nextInt'> ? true : false,
    true
  >
>
export type LoggerContract = Expect<
  Equal<Pick<LoggerTest, 'log' | 'info'> extends Pick<Logger, 'log' | 'info'> ? true : false, true>
>
