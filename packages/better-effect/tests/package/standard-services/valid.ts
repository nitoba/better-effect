import {
  Clock,
  ClockLive,
  ClockTest,
  Config,
  ConfigLive,
  CurrentRequest,
  IdGenerator,
  IdGeneratorLive,
  IdGeneratorTest,
  IdGeneratorTestLayer,
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
export type IdGeneratorTag = Expect<Equal<typeof IdGenerator.serviceTag, 'IdGenerator'>>
export type ClockProvider = Expect<Equal<typeof ClockLive extends object ? true : false, true>>
export type ConfigProvider = Expect<Equal<typeof ConfigLive extends object ? true : false, true>>
export type IdGeneratorProvider = Expect<
  Equal<typeof IdGeneratorLive extends object ? true : false, true>
>
export type ClockContract = Expect<
  Equal<Pick<ClockTest, 'now' | 'sleep'> extends Pick<Clock, 'now' | 'sleep'> ? true : false, true>
>
export type RandomContract = Expect<
  Equal<
    Pick<RandomSeeded, 'next' | 'nextInt'> extends Pick<Random, 'next' | 'nextInt'> ? true : false,
    true
  >
>
export type LoggerContract = Expect<
  Equal<Pick<LoggerTest, 'log' | 'info'> extends Pick<Logger, 'log' | 'info'> ? true : false, true>
>
export type IdGeneratorContract = Expect<
  Equal<Pick<IdGeneratorTest, 'next'> extends Pick<IdGenerator, 'next'> ? true : false, true>
>
export type IdGeneratorLayer = Expect<
  Equal<typeof IdGeneratorTestLayer extends object ? true : false, true>
>
