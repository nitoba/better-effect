// oxlint-disable anti-slop/no-runtime-typeof -- public reader options and adapter results cross untyped JavaScript boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- handlers and event-store adapters are user-provided boundaries.
// oxlint-disable anti-slop/no-chained-type-assertions -- erased generators are restored only at the public typed boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to validated adapter and handler boundaries.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- reader option records are validated at the public boundary.
// oxlint-disable anti-slop/no-known-value-widening -- signal links intentionally expose a small structural contract.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- read options are assembled from optional filters.

import { CurrentAbortSignal, Scope } from 'better-effect'
import type { AnyService, Effect, ServiceRequirement } from 'better-effect'
import { Clock } from 'better-effect/standard-services'
import { Result, UnhandledException } from 'better-result'
import type { Err, Result as ResultType } from 'better-result'

import { JobDefinitionError, validateDuration } from '../protocol'
import {
  isJobEventStoreToken,
  type AnyJobEventStoreToken,
  type DurableJobEvent,
  type JobEventCursor,
  type JobEventPage,
  type JobEventReadOptions,
  type JobEventStoreContract,
  type JobEventStoreOperation
} from './event-store'
import {
  JobEventConsumerAbortedError,
  JobEventStoreFailure,
  type JobEventStoreError
} from './event-errors'

const defaultPageSize = 100
const defaultPollIntervalMs = 100

export type JobEventFilters = Omit<JobEventReadOptions, 'after' | 'limit'>

export type JobEventsForEachOptions<Store extends AnyJobEventStoreToken> = {
  readonly store: Store
  readonly after?: JobEventCursor
  readonly filters?: JobEventFilters
  readonly pageSize?: number
  readonly pollIntervalMs?: number
  readonly signal?: AbortSignal
}

export type JobEventOperation<
  Success,
  Failure,
  Store extends AnyJobEventStoreToken,
  NeedsClock extends boolean = false,
  AdditionalRequirements extends AnyService = never
> = AsyncGenerator<
  | Err<never, Failure>
  | ServiceRequirement<
      | InstanceType<Store>
      | (NeedsClock extends true ? InstanceType<typeof Clock> : never)
      | AdditionalRequirements
    >,
  Success,
  unknown
>

export type JobEventsPageOperation<Store extends AnyJobEventStoreToken> = JobEventOperation<
  JobEventPage,
  JobEventStoreError,
  Store
>

export type JobEventsHandler<
  Success = unknown,
  Failure = unknown,
  Requirements extends AnyService = AnyService
> = (event: DurableJobEvent) => Effect.Program<Success, Failure, Requirements>

export type JobEventsForEachOperation<
  Store extends AnyJobEventStoreToken,
  HandlerProgram extends Effect.Program<any, any, AnyService>
> = JobEventOperation<
  void,
  | JobEventStoreError
  | JobEventConsumerAbortedError
  | JobDefinitionError
  | UnhandledException
  | Effect.Error<HandlerProgram>,
  Store,
  true,
  Effect.Requirements<HandlerProgram>
>

type JobEventStoreResult<Value> = ResultType<Value, JobEventStoreError>

type NormalizedForEachOptions<Store extends AnyJobEventStoreToken> = {
  readonly store: Store
  readonly after: JobEventCursor | undefined
  readonly filters: JobEventFilters
  readonly pageSize: number
  readonly pollIntervalMs: number
  readonly signal: AbortSignal | undefined
}

type EventWait = 'event' | 'poll'

type SignalLink = {
  readonly signal: AbortSignal
  readonly dispose: () => void
}

type RuntimeProgram = () => ResultType<unknown, unknown> | Promise<ResultType<unknown, unknown>>

const invalid = <Value>(field: string, message: string): ResultType<Value, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAbortSignal = (value: unknown): value is AbortSignal =>
  isObject(value) &&
  typeof value.aborted === 'boolean' &&
  typeof value.addEventListener === 'function' &&
  typeof value.removeEventListener === 'function'

const isResultValue = (value: unknown): value is ResultType<unknown, unknown> => {
  if (!isObject(value)) return false

  try {
    return (
      Result.isOk(value as unknown as ResultType<unknown, unknown>) ||
      Result.isError(value as unknown as ResultType<unknown, unknown>)
    )
  } catch {
    return false
  }
}

const runStoreOperation = async <Value>(
  operation: JobEventStoreOperation<Value, JobEventStoreError>
): Promise<JobEventStoreResult<Value>> => {
  try {
    const result = await operation
    if (isResultValue(result)) {
      return result as JobEventStoreResult<Value>
    }

    return Result.err(
      new JobEventStoreFailure({
        operation: 'operation',
        message: 'event store operation did not return a Result'
      })
    )
  } catch {
    return Result.err(
      new JobEventStoreFailure({
        operation: 'operation',
        message: 'event store operation failed'
      })
    )
  }
}

const linkSignals = (signals: readonly (AbortSignal | undefined)[]): SignalLink => {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)

  if (active.length === 0) {
    return { signal: new AbortController().signal, dispose: () => {} }
  }

  if (active.length === 1) {
    return { signal: active[0]!, dispose: () => {} }
  }

  const controller = new AbortController()
  const listeners: Array<readonly [AbortSignal, () => void]> = []
  let disposed = false

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
    listeners.length = 0
  }

  const abortFrom = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason)
    dispose()
  }

  for (const source of active) {
    if (source.aborted) {
      abortFrom(source)
      break
    }
    const listener = (): void => abortFrom(source)
    listeners.push([source, listener])
    source.addEventListener('abort', listener, { once: true })
  }

  return { signal: controller.signal, dispose }
}

const normalizeForEachOptions = <Store extends AnyJobEventStoreToken>(
  value: unknown
): ResultType<NormalizedForEachOptions<Store>, JobDefinitionError> => {
  if (!isObject(value)) return invalid('options', 'must be a plain object')

  const allowed = new Set(['store', 'after', 'filters', 'pageSize', 'pollIntervalMs', 'signal'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return invalid('options', 'contains unsupported fields')
  }

  if (!isJobEventStoreToken(value.store)) {
    return invalid('store', 'must be a JobEventStore token')
  }

  if (value.signal !== undefined && !isAbortSignal(value.signal)) {
    return invalid('signal', 'must be an AbortSignal')
  }

  if (value.filters !== undefined && !isObject(value.filters)) {
    return invalid('filters', 'must be a plain object')
  }

  const pageSize = value.pageSize ?? defaultPageSize
  if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1) {
    return invalid('pageSize', 'must be a positive safe integer')
  }

  const interval =
    value.pollIntervalMs === undefined
      ? Result.ok(defaultPollIntervalMs)
      : validateDuration(value.pollIntervalMs, 'pollIntervalMs')
  if (Result.isError(interval)) return interval

  return Result.ok({
    store: value.store as Store,
    after: value.after as JobEventCursor | undefined,
    filters: (value.filters ?? {}) as JobEventFilters,
    pageSize,
    pollIntervalMs: interval.value,
    signal: value.signal as AbortSignal | undefined
  })
}

const sleep = async (
  clock: InstanceType<typeof Clock>,
  milliseconds: number,
  signal: AbortSignal
): Promise<ResultType<void, JobEventConsumerAbortedError | UnhandledException>> => {
  try {
    await clock.sleep(milliseconds, { signal })
    return Result.ok(undefined)
  } catch (cause) {
    return signal.aborted
      ? Result.err(new JobEventConsumerAbortedError())
      : Result.err(new UnhandledException({ cause }))
  }
}

const waitForEventOrPoll = async (
  store: JobEventStoreContract,
  cursor: JobEventCursor,
  filters: JobEventFilters,
  clock: InstanceType<typeof Clock>,
  pollIntervalMs: number,
  signal: AbortSignal
): Promise<ResultType<EventWait, JobEventConsumerAbortedError | UnhandledException>> => {
  if (signal.aborted) return Result.err(new JobEventConsumerAbortedError())

  const waitController = new AbortController()
  const linked = linkSignals([signal, waitController.signal])
  const event = Promise.resolve(
    runStoreOperation(
      store.awaitEvents(
        filters.queues === undefined
          ? { after: cursor, signal: linked.signal }
          : { after: cursor, queues: filters.queues, signal: linked.signal }
      )
    )
  ).then((result) => ({ kind: 'event' as const, result }))
  const poll = sleep(clock, pollIntervalMs, linked.signal).then((result) => ({
    kind: 'poll' as const,
    result
  }))

  try {
    const first = await Promise.race([event, poll])
    if (first.kind === 'poll') {
      if (Result.isError(first.result)) return first.result
      return Result.ok('poll')
    }

    if (Result.isOk(first.result)) return Result.ok('event')
    if (signal.aborted) return Result.err(new JobEventConsumerAbortedError())

    const fallback = await poll
    if (Result.isError(fallback.result)) return fallback.result
    return Result.ok('poll')
  } catch (cause) {
    return signal.aborted
      ? Result.err(new JobEventConsumerAbortedError())
      : Result.err(new UnhandledException({ cause }))
  } finally {
    waitController.abort()
    linked.dispose()
  }
}

const invokeHandler = async (program: RuntimeProgram): Promise<ResultType<unknown, unknown>> => {
  try {
    const result = await program()
    if (isResultValue(result)) return result
    return Result.err(
      new UnhandledException({ cause: new TypeError('handler did not return a Result') })
    )
  } catch (cause) {
    return Result.err(new UnhandledException({ cause }))
  }
}

const pageOperation = async function* (
  token: AnyJobEventStoreToken,
  options: JobEventReadOptions
): AsyncGenerator<
  Err<never, JobEventStoreError> | ServiceRequirement<AnyService>,
  JobEventPage,
  unknown
> {
  const store = yield* token
  return yield* Result.await(Promise.resolve(runStoreOperation(store.read(options))))
}

const forEachOperation = async function* (
  rawOptions: unknown,
  handler: (event: DurableJobEvent) => RuntimeProgram
): AsyncGenerator<Err<never, unknown> | ServiceRequirement<AnyService>, void, unknown> {
  const options = yield* Result.await(
    Promise.resolve(normalizeForEachOptions<AnyJobEventStoreToken>(rawOptions))
  )
  const store = yield* options.store
  const clock = yield* Clock
  const runtimeSignal = yield* CurrentAbortSignal
  const scope = yield* Scope
  const stopped = new AbortController()
  const linked = linkSignals([runtimeSignal, options.signal, stopped.signal])
  scope.addFinalizer(() => stopped.abort())

  try {
    if (linked.signal.aborted)
      return yield* Result.await(Promise.resolve(Result.err(new JobEventConsumerAbortedError())))

    const initialCursor = options.after
    let currentCursor: JobEventCursor
    if (initialCursor === undefined) {
      currentCursor = yield* Result.await(Promise.resolve(runStoreOperation(store.tailCursor())))
    } else {
      currentCursor = initialCursor
    }

    for (;;) {
      if (linked.signal.aborted) {
        return yield* Result.await(Promise.resolve(Result.err(new JobEventConsumerAbortedError())))
      }

      const readOptions = { ...options.filters, limit: options.pageSize }
      const pageOptions: JobEventReadOptions =
        currentCursor === undefined ? readOptions : { ...readOptions, after: currentCursor }
      const page: JobEventPage = yield* Result.await(
        Promise.resolve(runStoreOperation(store.read(pageOptions)))
      )

      for (const event of page.events) {
        if (linked.signal.aborted) {
          return yield* Result.await(
            Promise.resolve(Result.err(new JobEventConsumerAbortedError()))
          )
        }

        yield* Result.await(Promise.resolve(invokeHandler(handler(event))))
      }

      if (page.nextCursor !== undefined) {
        currentCursor = page.nextCursor
      }

      if (page.events.length > 0 || page.nextCursor !== undefined) continue

      yield* Result.await(
        Promise.resolve(
          waitForEventOrPoll(
            store,
            currentCursor,
            options.filters,
            clock,
            options.pollIntervalMs,
            linked.signal
          )
        )
      )
    }
  } finally {
    stopped.abort()
    linked.dispose()
  }
}

const validatePageToken: (token: unknown) => asserts token is AnyJobEventStoreToken = (token) => {
  if (!isJobEventStoreToken(token)) {
    throw new TypeError('JobEvents.page requires a JobEventStore token')
  }
}

export const JobEvents = Object.freeze({
  page<Store extends AnyJobEventStoreToken>(
    store: Store,
    options: JobEventReadOptions = {}
  ): JobEventsPageOperation<Store> {
    validatePageToken(store)
    return pageOperation(store, options) as JobEventsPageOperation<Store>
  },
  forEach<
    Store extends AnyJobEventStoreToken,
    HandlerProgram extends Effect.Program<any, any, AnyService>
  >(
    options: JobEventsForEachOptions<Store>,
    handler: (event: DurableJobEvent) => HandlerProgram
  ): JobEventsForEachOperation<Store, HandlerProgram> {
    return forEachOperation(options, handler) as JobEventsForEachOperation<Store, HandlerProgram>
  }
})

export type JobEventsApi = typeof JobEvents
