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

const assertDelay = (milliseconds: number): void => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError('Delay must be a finite non-negative number')
  }
}

const abortError = (): DOMException => new DOMException('The operation was aborted', 'AbortError')

const abortReason = (signal: AbortSignal): AbortSignal['reason'] =>
  signal.reason === undefined ? abortError() : signal.reason

/** Optional cooperative cancellation for a host or test Clock sleep. */
export type ClockSleepOptions = {
  readonly signal?: AbortSignal
}

/** Host-backed time and waiting service. */
export class Clock extends Service<Clock>()('Clock') {
  now(): Date {
    return new Date()
  }

  /** Rejects with the signal reason, or an AbortError-compatible fallback. */
  sleep(milliseconds: number, options?: ClockSleepOptions): Promise<void> {
    assertDelay(milliseconds)
    const signal = options?.signal

    if (signal?.aborted) {
      return Promise.reject(abortReason(signal))
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false

      function cleanup(): void {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }

        signal?.removeEventListener('abort', onAbort)
      }

      function settle(callback: () => void): void {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        callback()
      }

      function onAbort(): void {
        if (signal !== undefined) {
          settle(() => reject(abortReason(signal)))
        }
      }

      try {
        signal?.addEventListener('abort', onAbort, { once: true })

        if (signal?.aborted) {
          onAbort()
          return
        }

        const handle = setTimeout(() => settle(resolve), milliseconds)

        if (settled) {
          clearTimeout(handle)
        } else {
          timer = handle
        }
      } catch (cause) {
        settle(() => reject(cause))
      }
    })
  }
}

/** The default host Clock provider. */
export const ClockLive = Layer.make(Clock)

type ClockWaiter = {
  readonly at: number
  readonly resolve: () => void
  readonly reject: (cause?: unknown) => void
  readonly signal: AbortSignal | undefined
  readonly onAbort: () => void
  settled: boolean
}

/** Limits deadline advances performed by `ClockTest.runAll`. */
export type ClockTestRunAllOptions = {
  readonly maxSteps?: number
}

const defaultClockTestMaxSteps = 1_000

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

  /** Number of sleeps that have not been settled or cancelled. */
  get pendingSleeps(): number {
    return this.waiters.length
  }

  now(): Date {
    return new Date(this.currentTime)
  }

  /** Set an absolute time; moving backward leaves existing absolute deadlines unchanged. */
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

  sleep(milliseconds: number, options?: ClockSleepOptions): Promise<void> {
    assertDelay(milliseconds)
    const signal = options?.signal

    if (signal?.aborted) {
      return Promise.reject(abortReason(signal))
    }

    return new Promise<void>((resolve, reject) => {
      let waiter!: ClockWaiter
      const onAbort = (): void => {
        if (signal !== undefined) {
          this.cancelWaiter(waiter, abortReason(signal))
        }
      }

      waiter = {
        at: this.currentTime + milliseconds,
        resolve,
        reject,
        signal,
        onAbort,
        settled: false
      }
      this.enqueueWaiter(waiter)

      try {
        signal?.addEventListener('abort', onAbort, { once: true })

        if (signal?.aborted) {
          this.cancelWaiter(waiter, abortReason(signal))
          return
        }
      } catch (cause) {
        this.cancelWaiter(waiter, cause)
        return
      }

      this.flushWaiters()
    })
  }

  /** Advance synchronously; due Promise continuations run after this method returns. */
  advanceToNext(): boolean {
    const next = this.waiters[0]

    if (next === undefined) {
      return false
    }

    this.currentTime = next.at
    this.flushWaiters()
    return true
  }

  /** Advance all pending deadlines, guarding at 1,000 steps by default. */
  async runAll(options?: ClockTestRunAllOptions | number): Promise<number> {
    const maxSteps = getMaxSteps(options)
    let steps = 0

    while (this.pendingSleeps > 0) {
      if (steps >= maxSteps) {
        throw new RangeError(`ClockTest.runAll exceeded maxSteps (${maxSteps})`)
      }

      this.advanceToNext()
      steps += 1
      await Promise.resolve()
    }

    return steps
  }

  static layer(initial: Date | number = 0) {
    return Layer.succeed(Clock, new ClockTest(initial))
  }

  private enqueueWaiter(waiter: ClockWaiter): void {
    const index = this.waiters.findIndex((pending) => pending.at > waiter.at)

    if (index === -1) {
      this.waiters.push(waiter)
    } else {
      this.waiters.splice(index, 0, waiter)
    }
  }

  private cancelWaiter(waiter: ClockWaiter, cause: unknown): void {
    const index = this.waiters.indexOf(waiter)

    if (index !== -1) {
      this.waiters.splice(index, 1)
    }

    this.finishWaiter(waiter, () => waiter.reject(cause))
  }

  private flushWaiters(): void {
    while (true) {
      const waiter = this.waiters[0]

      if (waiter === undefined || waiter.at > this.currentTime) {
        return
      }

      this.waiters.shift()
      this.finishWaiter(waiter, waiter.resolve)
    }
  }

  private finishWaiter(waiter: ClockWaiter, finish: () => void): void {
    if (waiter.settled) {
      return
    }

    waiter.settled = true
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
    finish()
  }
}

const getMaxSteps = (options?: ClockTestRunAllOptions | number): number => {
  const maxSteps =
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- support a numeric max-step shorthand.
    typeof options === 'number' ? options : (options?.maxSteps ?? defaultClockTestMaxSteps)

  if (!Number.isInteger(maxSteps) || maxSteps < 0) {
    throw new RangeError('ClockTest.runAll maxSteps must be a finite non-negative integer')
  }

  return maxSteps
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
