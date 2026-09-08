// oxlint-disable anti-slop/no-runtime-typeof -- the public Layer factory crosses an untyped JavaScript boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- handlers and factories are user-provided boundaries.
// oxlint-disable anti-slop/no-chained-type-assertions -- erased consumer options are restored at the Layer boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to validated public boundaries.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- public option records are validated before use.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- exact optional properties are omitted at the runtime boundary.

import { Effect, Layer, Runtime, Service } from 'better-effect'
import type { AnyService, RuntimeExecutor, ServiceRequirement, ServiceToken } from 'better-effect'
import { Clock } from 'better-effect/standard-services'
import { Result, UnhandledException } from 'better-result'
import type { Result as ResultType } from 'better-result'

import {
  isJobEventStoreToken,
  type AnyJobEventStoreToken,
  type DurableJobEvent,
  type JobEventCursor
} from './event-store'
import { JobEvents, type JobEventFilters, type JobEventsHandler } from './events'

export type JobEventConsumerHandler = JobEventsHandler<any, any, AnyService>

export type JobEventConsumerOptions<
  Store extends AnyJobEventStoreToken,
  Handler extends JobEventConsumerHandler
> = {
  readonly eventStore: Store
  readonly after?: JobEventCursor
  readonly filters?: JobEventFilters
  readonly pageSize?: number
  readonly pollIntervalMs?: number
  readonly signal?: AbortSignal
  readonly concurrency?: 1
  readonly handler: Handler
}

type AnyJobEventConsumerOptions = Omit<
  JobEventConsumerOptions<AnyJobEventStoreToken, JobEventConsumerHandler>,
  'concurrency'
> & {
  readonly concurrency?: number
}

export type JobEventConsumerFactory<
  Yield extends ServiceRequirement<unknown>,
  Options extends AnyJobEventConsumerOptions
> = () => Generator<Yield, Options, unknown> | AsyncGenerator<Yield, Options, unknown>

export type JobEventConsumerValueFactory<Options extends AnyJobEventConsumerOptions> = () =>
  | Options
  | PromiseLike<Options>

type ConsumerStore<Options> = Options extends {
  readonly eventStore: infer Store extends AnyJobEventStoreToken
}
  ? InstanceType<Store>
  : never

type ConsumerHandlerProgram<Options> = Options extends {
  readonly handler: (event: DurableJobEvent) => infer Program
}
  ? Program
  : never

export type JobEventConsumerLayerRequirements<Yield, Options extends AnyJobEventConsumerOptions> =
  | InferConsumerYieldRequirements<Yield>
  | ConsumerStore<Options>
  | InstanceType<typeof Clock>
  | Effect.Requirements<ConsumerHandlerProgram<Options>>

type InferConsumerYieldRequirements<Yield> =
  Yield extends ServiceRequirement<infer Requirement>
    ? Requirement extends AnyService
      ? Requirement
      : never
    : never

export type JobEventConsumerState = 'running' | 'quiescing' | 'stopped' | 'failed'

export interface JobEventConsumerHandle {
  readonly state: JobEventConsumerState
  stop(): Promise<void>
  awaitStopped(): Promise<void>
}

export type JobEventConsumerInstance<Tag extends string> = JobEventConsumerHandle &
  Service.Identity<Tag>

type JobEventConsumerTag<Tag extends string> = string extends Tag
  ? never
  : Tag extends ''
    ? never
    : Tag

export type JobEventConsumerToken<Tag extends string> = ServiceToken<
  Tag,
  JobEventConsumerInstance<Tag>
> & {
  readonly layer: {
    <const Options extends AnyJobEventConsumerOptions>(
      factory: JobEventConsumerValueFactory<Options>
    ): Layer<JobEventConsumerInstance<Tag>, JobEventConsumerLayerRequirements<never, Options>>
    <Yield extends ServiceRequirement<unknown>, const Options extends AnyJobEventConsumerOptions>(
      factory: JobEventConsumerFactory<Yield, Options>
    ): Layer<JobEventConsumerInstance<Tag>, JobEventConsumerLayerRequirements<Yield, Options>>
  }
  readonly succeed: (value: JobEventConsumerHandle) => Layer<JobEventConsumerInstance<Tag>, never>
}

export declare namespace JobEventConsumer {
  export type Any = JobEventConsumerHandle & Service.Identity<string>
  export type Handle = JobEventConsumerHandle
  export type State = JobEventConsumerState
  export type Instance<Tag extends string> = JobEventConsumerInstance<Tag>
  export type Token<Tag extends string> = JobEventConsumerToken<Tag>
  export type Options<
    Store extends AnyJobEventStoreToken,
    Handler extends JobEventConsumerHandler
  > = JobEventConsumerOptions<Store, Handler>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAbortSignal = (value: unknown): value is AbortSignal =>
  isObject(value) &&
  typeof value.aborted === 'boolean' &&
  typeof value.addEventListener === 'function' &&
  typeof value.removeEventListener === 'function'

const isHandler = (value: unknown): value is JobEventConsumerHandler => typeof value === 'function'

const normalizeFactory = <
  Yield extends ServiceRequirement<unknown>,
  Options extends AnyJobEventConsumerOptions
>(
  factory: JobEventConsumerFactory<Yield, Options> | JobEventConsumerValueFactory<Options>
): (() => AsyncGenerator<Yield, Options, unknown>) =>
  async function* () {
    const result = factory()

    if (isGeneratorResult<Yield, Options>(result)) {
      return yield* result
    }

    return await result
  }

const isGeneratorResult = <
  Yield extends ServiceRequirement<unknown>,
  Options extends AnyJobEventConsumerOptions
>(
  value:
    | Options
    | PromiseLike<Options>
    | Generator<Yield, Options, unknown>
    | AsyncGenerator<Yield, Options, unknown>
): value is Generator<Yield, Options, unknown> | AsyncGenerator<Yield, Options, unknown> =>
  isObject(value) && 'next' in value && typeof value.next === 'function'

const normalizeOptions = (value: unknown): AnyJobEventConsumerOptions => {
  if (!isObject(value)) throw new TypeError('JobEventConsumer Layer factory must return an object')

  const allowed = new Set([
    'eventStore',
    'after',
    'filters',
    'pageSize',
    'pollIntervalMs',
    'signal',
    'concurrency',
    'handler'
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`JobEventConsumer option is unsupported: ${key}`)
  }

  if (!isJobEventStoreToken(value.eventStore)) {
    throw new TypeError('JobEventConsumer.eventStore must be a JobEventStore token')
  }

  if (!isHandler(value.handler)) {
    throw new TypeError('JobEventConsumer.handler must be an Effect Program factory')
  }

  if (value.signal !== undefined && !isAbortSignal(value.signal)) {
    throw new TypeError('JobEventConsumer.signal must be an AbortSignal')
  }

  if (value.concurrency !== undefined && value.concurrency !== 1) {
    throw new TypeError('JobEventConsumer only supports concurrency: 1')
  }

  return value as unknown as AnyJobEventConsumerOptions
}

type SignalLink = {
  readonly signal: AbortSignal
  readonly dispose: () => void
}

const linkSignals = (signals: readonly (AbortSignal | undefined)[]): SignalLink => {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (active.length === 0) return { signal: new AbortController().signal, dispose: () => {} }
  if (active.length === 1) return { signal: active[0]!, dispose: () => {} }

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

const isResult = (value: unknown): value is ResultType<unknown, unknown> => {
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

class ConsumerHandle implements JobEventConsumerHandle {
  private currentState: JobEventConsumerState = 'running'
  private stopRequested = false
  private readonly stopped: Promise<void>

  constructor(
    private readonly controller: AbortController,
    private readonly completion: Promise<void>,
    private readonly linked: SignalLink
  ) {
    this.stopped = completion.then(
      () => {
        this.currentState = 'stopped'
      },
      (cause) => {
        this.currentState = this.stopRequested || linked.signal.aborted ? 'stopped' : 'failed'
        throw cause
      }
    )
    void this.stopped.catch(() => undefined)
    void this.stopped.then(
      () => this.linked.dispose(),
      () => this.linked.dispose()
    )
  }

  get state(): JobEventConsumerState {
    return this.currentState
  }

  quiesce(): void {
    if (this.currentState !== 'running') return
    this.currentState = 'quiescing'
    this.stopRequested = true
    if (!this.controller.signal.aborted) this.controller.abort()
  }

  stop(): Promise<void> {
    this.quiesce()
    return this.stopped
  }

  awaitStopped(): Promise<void> {
    return this.stopped
  }

  async release(): Promise<void> {
    this.quiesce()
    await this.stopped.catch(() => undefined)
    this.linked.dispose()
  }
}

const makeConsumer = async (
  executor: RuntimeExecutor<AnyService>,
  rawOptions: unknown
): Promise<ConsumerHandle> => {
  const options = normalizeOptions(rawOptions)
  const stopController = new AbortController()
  const linked = linkSignals([stopController.signal, options.signal])

  let loop: Promise<void>
  try {
    loop = executor.run(async () => {
      const forEachOptions = {
        store: options.eventStore,
        ...(options.after === undefined ? {} : { after: options.after }),
        ...(options.filters === undefined ? {} : { filters: options.filters }),
        ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        signal: linked.signal
      }
      const result = await Effect.gen(async function* () {
        return Result.ok(
          yield* JobEvents.forEach(forEachOptions, (event) =>
            // oxlint-disable-next-line require-yield -- Effect.fn is the required lazy Program boundary for handlers.
            Effect.fn(async function* () {
              return await executor.run(() => options.handler(event)())
            })
          )
        )
      })

      if (!isResult(result)) {
        throw new UnhandledException({
          cause: new TypeError('consumer loop did not return a Result')
        })
      }
      if (Result.isError(result)) throw result.error
    })
  } catch (cause) {
    stopController.abort(cause)
    linked.dispose()
    throw cause
  }

  return new ConsumerHandle(
    stopController,
    loop.then(() => undefined),
    linked
  )
}

/** A named, Layer-owned durable Job Event consumer. */
export const JobEventConsumer = Object.freeze({
  service<const Tag extends string>(tag: JobEventConsumerTag<Tag>): JobEventConsumerToken<Tag> {
    type Instance = JobEventConsumerInstance<Tag>

    const baseToken = Service<Instance>()(tag)
    const token = class extends (baseToken as unknown as new () => Service.Identity<Tag>) {
      constructor() {
        super()
        throw new TypeError('JobEventConsumer Service tokens are not constructible; use layer')
      }
    }
    const layerToken = token as unknown as ServiceToken<Tag, Instance>

    const layer = <
      Yield extends ServiceRequirement<unknown>,
      const Options extends AnyJobEventConsumerOptions
    >(
      factory: JobEventConsumerFactory<Yield, Options> | JobEventConsumerValueFactory<Options>
    ): Layer<Instance, JobEventConsumerLayerRequirements<Yield, Options>> =>
      Layer.scopedGen(
        layerToken,
        async function* () {
          const options = yield* normalizeFactory<Yield, Options>(factory)()
          const executor = yield* Runtime.executor<AnyService>()
          return layerToken.of(await makeConsumer(executor, options))
        },
        {
          quiesce: (consumer) => (consumer as unknown as ConsumerHandle).quiesce(),
          release: (consumer) => (consumer as unknown as ConsumerHandle).release()
        }
      ) as Layer<Instance, JobEventConsumerLayerRequirements<Yield, Options>>

    const succeed = (value: JobEventConsumerHandle): Layer<Instance, never> =>
      Layer.succeed(layerToken, value) as Layer<Instance, never>

    Object.defineProperties(token, {
      layer: { configurable: false, enumerable: true, value: layer, writable: false },
      succeed: { configurable: false, enumerable: true, value: succeed, writable: false }
    })

    return token as unknown as JobEventConsumerToken<Tag>
  }
})

export type JobEventConsumerApi = typeof JobEventConsumer
