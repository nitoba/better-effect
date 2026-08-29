import { CurrentAbortSignal } from '../runtime'
import { Layer } from '../layer'
import { Service } from '../service'

export { CurrentAbortSignal }

export { Config, ConfigLive, ConfigSourceError, ConfigValidationError } from './config'

export type {
  ConfigError,
  ConfigFromEnvOptions,
  ConfigInput,
  ConfigIssue,
  ConfigOutput,
  ConfigSource,
  ConfigSourceOptions,
  ConfigValue,
  StandardSchemaV1
} from './config'

export {
  IdGenerator,
  IdGeneratorExhaustedError,
  IdGeneratorLive,
  IdGeneratorTest,
  IdGeneratorTestLayer,
  IdGeneratorUnavailableError
} from './id-generator'

const assertDelay = (milliseconds: number): void => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError('Delay must be a finite non-negative number')
  }
}

/** Host-backed time and waiting service. */
export class Clock extends Service<Clock>()('Clock') {
  now(): Date {
    return new Date()
  }

  sleep(milliseconds: number): Promise<void> {
    assertDelay(milliseconds)
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }
}

/** The default host Clock provider. */
export const ClockLive = Layer.make(Clock)

type ClockWaiter = {
  readonly at: number
  readonly resolve: () => void
}

/** Deterministic Clock implementation for tests. */
export class ClockTest implements Service.Contract<Clock> {
  private currentTime: number

  private readonly waiters: ClockWaiter[] = []

  constructor(initial: Date | number = 0) {
    this.currentTime = initial instanceof Date ? initial.getTime() : initial

    if (!Number.isFinite(this.currentTime)) {
      throw new RangeError('ClockTest time must be finite')
    }
  }

  now(): Date {
    return new Date(this.currentTime)
  }

  setTime(value: Date | number): void {
    const next = value instanceof Date ? value.getTime() : value

    if (!Number.isFinite(next)) {
      throw new RangeError('ClockTest time must be finite')
    }

    this.currentTime = next
    this.flushWaiters()
  }

  advance(milliseconds: number): void {
    assertDelay(milliseconds)
    this.currentTime += milliseconds
    this.flushWaiters()
  }

  sleep(milliseconds: number): Promise<void> {
    assertDelay(milliseconds)

    return new Promise((resolve) => {
      this.waiters.push({ at: this.currentTime + milliseconds, resolve })
      this.flushWaiters()
    })
  }

  static layer(initial: Date | number = 0) {
    return Layer.succeed(Clock, new ClockTest(initial))
  }

  private flushWaiters(): void {
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      const waiter = this.waiters[index]!

      if (waiter.at <= this.currentTime) {
        this.waiters.splice(index, 1)
        waiter.resolve()
      }
    }
  }
}

export const ClockTestLayer = (initial: Date | number = 0) => ClockTest.layer(initial)

/** Host-backed pseudo-random number service. */
export class Random extends Service<Random>()('Random') {
  next(): number {
    return Math.random()
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError('Random.nextInt maxExclusive must be a positive integer')
    }

    return Math.floor(this.next() * maxExclusive)
  }
}

/** The default host Random provider. */
export const RandomLive = Layer.make(Random)

/** Reproducible pseudo-random implementation with isolated mutable state. */
export class RandomSeeded implements Service.Contract<Random> {
  private state: number

  constructor(seed: number) {
    if (!Number.isFinite(seed)) {
      throw new RangeError('RandomSeeded seed must be finite')
    }

    this.state = seed >>> 0
  }

  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0
    return this.state / 0x1_0000_0000
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError('RandomSeeded.nextInt maxExclusive must be a positive integer')
    }

    return Math.floor(this.next() * maxExclusive)
  }

  static layer(seed: number) {
    return Layer.succeed(Random, new RandomSeeded(seed))
  }
}

export const RandomSeededLayer = (seed: number) => RandomSeeded.layer(seed)

export type LoggerLevel = 'debug' | 'info' | 'warn' | 'error'

export type LoggerEvent = {
  level: LoggerLevel
  message: string
  data?: LoggerData
}

export type LoggerData =
  | string
  | number
  | boolean
  | bigint
  | null
  | readonly LoggerData[]
  | { readonly [key: string]: LoggerData }
type LoggerInput = LoggerEvent | LoggerLevel

const isLoggerLevel = (value: LoggerInput): value is LoggerLevel =>
  value === 'debug' || value === 'info' || value === 'warn' || value === 'error'

const toLoggerEvent = (input: LoggerInput, message?: string, data?: LoggerData): LoggerEvent => {
  if (!isLoggerLevel(input)) {
    return input
  }

  const event: LoggerEvent = { level: input, message: message ?? '' }

  if (data !== undefined) {
    event.data = data
  }

  return event
}

/** Structured host logger bridge. */
export class Logger extends Service<Logger>()('Logger') {
  log(event: LoggerEvent): void
  log(level: LoggerLevel, message: string, data?: LoggerData): void
  log(first: LoggerInput, message?: string, data?: LoggerData): void {
    const event = toLoggerEvent(first, message, data)

    const write = console[event.level]

    if (event.data === undefined) {
      write.call(console, event.message)
    } else {
      write.call(console, event.message, event.data)
    }
  }

  debug(message: string, data?: LoggerData): void {
    this.log('debug', message, data)
  }

  info(message: string, data?: LoggerData): void {
    this.log('info', message, data)
  }

  warn(message: string, data?: LoggerData): void {
    this.log('warn', message, data)
  }

  error(message: string, data?: LoggerData): void {
    this.log('error', message, data)
  }
}

/** The default host Logger provider. */
export const LoggerLive = Layer.make(Logger)

/** Ordered in-memory Logger implementation for tests. */
export class LoggerTest implements Service.Contract<Logger> {
  readonly events: LoggerEvent[] = []

  log(event: LoggerEvent): void
  log(level: LoggerLevel, message: string, data?: LoggerData): void
  log(first: LoggerInput, message?: string, data?: LoggerData): void {
    const event = toLoggerEvent(first, message, data)

    this.events.push(event)
  }

  debug(message: string, data?: LoggerData): void {
    this.log('debug', message, data)
  }

  info(message: string, data?: LoggerData): void {
    this.log('info', message, data)
  }

  warn(message: string, data?: LoggerData): void {
    this.log('warn', message, data)
  }

  error(message: string, data?: LoggerData): void {
    this.log('error', message, data)
  }

  clear(): void {
    this.events.length = 0
  }

  static make() {
    const logger = new LoggerTest()
    return { logger, layer: Layer.succeed(Logger, logger) }
  }

  static layer(logger: LoggerTest = new LoggerTest()) {
    return Layer.succeed(Logger, logger)
  }
}

export const LoggerTestLayer = () => LoggerTest.layer()

/** Execution-local request value carried by a normal Service provider. */
export class CurrentRequest extends Service<CurrentRequest>()('CurrentRequest') {
  readonly request: unknown

  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  constructor(readonly value: unknown) {
    super()
    this.request = value
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  static layer(value: unknown) {
    return Layer.succeed(CurrentRequest, new CurrentRequest(value))
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const CurrentRequestLayer = (value: unknown) => CurrentRequest.layer(value)
