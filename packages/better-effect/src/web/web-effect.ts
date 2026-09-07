import { Result } from 'better-result'

import { Layer } from '../layer'
import type { LayerInput } from '../layer/inference'
import { CurrentRequest } from '../standard-services/current-request'
import type { RuntimeExecutor, RuntimeManagedExecution, RuntimeManagedPlan } from '../runtime'
import type { AnyService } from '../service'
import type { EffectError, EffectSuccess } from '../effect/types'
import { assertResponse, defaultFailure, defaultSuccess } from './responses'
import type {
  AnyProgram,
  CompleteWebProgram,
  CompleteWebStreamProgram,
  DefaultRequestLayer,
  WebEffectStream,
  WebEffectStreamContext,
  WebEffectStreamOptions,
  WebEffectOptions,
  WebEffectProgram,
  WebProgramChecks,
  WebStreamProgramChecks,
  WebRequestLayerChecks
} from './types'

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- this boundary validates opaque Web stream protocols before execution. */

const DEFAULT_UNCONSUMED_TIMEOUT_MS = 30_000

type Deferred<A> = {
  readonly promise: Promise<A>
  readonly resolve: (value: A | PromiseLike<A>) => void
  readonly reject: (cause?: unknown) => void
}

const deferred = <A>(): Deferred<A> => {
  let resolve!: (value: A | PromiseLike<A>) => void
  let reject!: (cause?: unknown) => void
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null

const isReadableStream = (value: unknown): value is ReadableStream<Uint8Array> =>
  isObject(value) && typeof value.getReader === 'function'

const isAsyncIterable = (value: unknown): value is AsyncIterable<Uint8Array> =>
  isObject(value) && typeof value[Symbol.asyncIterator] === 'function'

const assertStreamDescriptor = (value: unknown): WebEffectStream => {
  if (!isObject(value) || typeof value.producer !== 'function') {
    throw new TypeError('WebEffect.streamWith Programs must return an explicit stream descriptor')
  }

  return value as WebEffectStream
}

const assertStreamSource = (
  value: unknown
): ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> => {
  if (!isReadableStream(value) && !isAsyncIterable(value)) {
    throw new TypeError('WebEffect stream producers must return a ReadableStream or AsyncIterable')
  }

  return value
}

const streamResponseInit = (descriptor: WebEffectStream): ResponseInit => {
  const init: ResponseInit = {}

  if (descriptor.status !== undefined) init.status = descriptor.status
  if (descriptor.statusText !== undefined) init.statusText = descriptor.statusText
  if (descriptor.headers !== undefined) init.headers = descriptor.headers

  return init
}

type ManagedBody = {
  readonly body: ReadableStream<Uint8Array>
  readonly completion: Promise<void>
  readonly cancel: (reason?: unknown) => Promise<void>
  readonly start: () => void
}

/** @internal A managed Web response plan used by framework adapters. */
export type ManagedWebResponse = RuntimeManagedPlan<Response> & {
  /** @internal Keep the request execution alive after readiness is returned. */
  readonly retainCompletion?: boolean
}

const makeManagedBody = (
  descriptor: WebEffectStream,
  managedPromise: Promise<RuntimeManagedExecution<unknown>>,
  timeoutMs: number
): ManagedBody => {
  const completionDeferred = deferred<void>()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let iterator: AsyncIterator<Uint8Array> | undefined
  let sourceStarted = false
  let settled = false
  let pulling = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const makeTimeout = (): Error => {
    const error = new Error('WebEffect stream body consumption timed out')
    error.name = 'WebEffectStreamTimeoutError'
    return error
  }

  const fail = (cause: unknown, errorBody: boolean): void => {
    if (settled) return
    settled = true
    clearTimer()
    completionDeferred.reject(cause)
    if (errorBody) {
      try {
        controller.error(cause)
      } catch {
        // The body may already have been cancelled by its consumer.
      }
    }
  }

  const succeed = (): void => {
    if (settled) return
    settled = true
    clearTimer()
    completionDeferred.resolve(undefined)
  }

  const closeSource = async (reason?: unknown): Promise<void> => {
    const managed = await managedPromise

    try {
      await managed.run(async () => {
        if (reader !== undefined) {
          await reader.cancel(reason)
          reader.releaseLock()
          reader = undefined
        }

        if (iterator !== undefined) {
          await iterator.return?.()
          iterator = undefined
        }
      })
    } catch {
      // The managed execution remains the owner of the primary cancellation cause.
    }
  }

  const cancel = async (reason?: unknown): Promise<void> => {
    if (settled) return
    const cause = reason === undefined ? new Error('WebEffect stream body cancelled') : reason
    await closeSource(cause)
    fail(cause, false)
  }

  const pull = async (): Promise<void> => {
    if (settled || pulling) return
    pulling = true
    clearTimer()

    try {
      const managed = await managedPromise
      const result = await managed.run(async () => {
        if (!sourceStarted) {
          sourceStarted = true
          const source = assertStreamSource(await descriptor.producer({ signal: managed.signal }))

          if (isReadableStream(source)) {
            reader = source.getReader()
          } else {
            iterator = source[Symbol.asyncIterator]()
          }
        }

        if (reader !== undefined) return await reader.read()
        if (iterator !== undefined) return await iterator.next()
        throw new TypeError('WebEffect stream producer did not expose a readable source')
      })

      if (result.done) {
        if (reader !== undefined) {
          reader.releaseLock()
          reader = undefined
        }
        iterator = undefined
        succeed()
        controller.close()
        return
      }

      if (!(result.value instanceof Uint8Array)) {
        throw new TypeError('WebEffect stream producers must yield Uint8Array chunks')
      }

      controller.enqueue(new Uint8Array(result.value))
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          void cancel(makeTimeout())
        }, timeoutMs)
      }
    } catch (cause) {
      await closeSource(cause)
      fail(cause, true)
    } finally {
      pulling = false
    }
  }

  const body = new ReadableStream<Uint8Array>(
    {
      start(nextController) {
        controller = nextController
      },
      pull,
      cancel
    },
    { highWaterMark: 0, size: () => 1 }
  )

  return {
    body,
    completion: completionDeferred.promise,
    cancel,
    start: () => {
      if (timeoutMs > 0 && !settled) {
        timer = setTimeout(() => {
          void cancel(makeTimeout())
        }, timeoutMs)
      }
    }
  }
}

/** @internal Build a response plan without admitting a second Runtime execution. */
export const makeManagedResponse = (
  descriptor: WebEffectStream,
  managedPromise: Promise<RuntimeManagedExecution<unknown>>,
  timeoutMs = DEFAULT_UNCONSUMED_TIMEOUT_MS
): ManagedWebResponse => {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      'WebEffect stream unconsumedTimeoutMs must be a finite non-negative number'
    )
  }

  const body = makeManagedBody(descriptor, managedPromise, timeoutMs)
  const response = new Response(body.body, streamResponseInit(descriptor))
  body.start()

  return {
    readiness: response,
    completion: body.completion,
    cancel: body.cancel,
    retainCompletion: true
  }
}

const combineRequestLayer = <RequestLayer extends LayerInput>(
  request: Request,
  customLayer: RequestLayer | undefined
): LayerInput => {
  const currentRequestLayer = CurrentRequest.layer(request)

  if (customLayer === undefined) {
    return currentRequestLayer
  }

  // SAFETY: WebEffect.handleWith validates the custom Layer's shape and override contract at its public boundary.
  return Layer.override(currentRequestLayer, customLayer as never)
}

/** @internal Run a framework boundary with a readiness/completion split. */
export type ManagedWebBoundaryOptions = {
  readonly requestLayer?: (request: Request) => LayerInput
  readonly onSuccess: (
    result: { readonly value: unknown },
    managed: Promise<RuntimeManagedExecution<unknown>>
  ) => ManagedWebResponse | PromiseLike<ManagedWebResponse>
  readonly onFailure?: (error: unknown) => Response | PromiseLike<Response>
}

/** @internal Adapt a managed Runtime execution for framework-owned boundaries. */
export const runManagedWith = async (
  executor: RuntimeExecutor<AnyService>,
  request: Request,
  program: AnyProgram,
  options: ManagedWebBoundaryOptions
): Promise<Response> => {
  const managedDeferred = deferred<RuntimeManagedExecution<unknown>>()
  let retainCompletion = false
  const managedProgram = async (): Promise<ManagedWebResponse> => {
    const result = await program()

    if (Result.isError(result)) {
      const response = assertResponse(await (options.onFailure ?? defaultFailure)(result.error))
      return {
        readiness: response,
        completion: Promise.reject(result.error),
        cancel: async () => {}
      }
    }

    const plan = await options.onSuccess({ value: result.value }, managedDeferred.promise)
    retainCompletion = plan.retainCompletion === true
    return plan
  }

  const requestLayer = combineRequestLayer(request, options.requestLayer?.(request))
  let managed: RuntimeManagedExecution<unknown> | undefined

  try {
    managed = executor.runWithManaged(requestLayer as Layer.Any, managedProgram as never, {
      signal: request.signal
    })
    managedDeferred.resolve(managed)
    const response = assertResponse(await managed.readiness)
    if (retainCompletion) {
      void managed.completion.catch(() => undefined)
    } else {
      await managed.completion.catch(() => undefined)
    }
    return response
  } catch (cause) {
    managedDeferred.reject(cause)
    if (managed !== undefined) {
      void managed.completion.catch(() => undefined)
      await managed.cancel(cause).catch(() => undefined)
    }
    throw cause
  }
}

/** Execute one Result-valued Program inside a framework-neutral Web request boundary. */
export class WebEffect {
  private constructor() {}

  /**
   * Run one lazy Program and map its Result to a standard Web Response.
   *
   * The request Layer and execution Scope are owned by the Runtime behind the
   * supplied executor; request resources close before this Promise resolves,
   * while Runtime-root resources remain owned by that Runtime.
   */
  static handleWith<
    Provided extends AnyService,
    const Program extends AnyProgram,
    RequestLayer extends LayerInput,
    Failure = EffectError<Program>
  >(
    executor: RuntimeExecutor<Provided>,
    request: Request,
    program: Program,
    options: WebEffectOptions<NoInfer<Failure>, RequestLayer, EffectSuccess<Program>> & {
      readonly requestLayer: (request: Request) => RequestLayer
    } & WebRequestLayerChecks<Provided, RequestLayer> &
      WebProgramChecks<Provided, RequestLayer, Program, NoInfer<Failure>>
  ): Promise<Response>

  static handleWith<
    Provided extends AnyService,
    const Program extends AnyProgram,
    Failure = EffectError<Program>
  >(
    executor: RuntimeExecutor<Provided>,
    request: Request,
    program: Program & CompleteWebProgram<Provided, DefaultRequestLayer, Program, NoInfer<Failure>>,
    options: WebEffectOptions<NoInfer<Failure>, DefaultRequestLayer, EffectSuccess<Program>>
  ): Promise<Response>

  static handleWith<Provided extends AnyService, const Program extends AnyProgram>(
    executor: RuntimeExecutor<Provided>,
    request: Request,
    program: Program & CompleteWebProgram<Provided, DefaultRequestLayer, Program>,
    options?: undefined
  ): Promise<Response>

  static async handleWith(
    executor: RuntimeExecutor<AnyService>,
    request: Request,
    program: AnyProgram,
    options?: WebEffectOptions<unknown, LayerInput, unknown>
  ): Promise<Response> {
    const boundaryOptions = options
    const onSuccess = boundaryOptions?.onSuccess ?? defaultSuccess
    const onFailure = boundaryOptions?.onFailure ?? defaultFailure
    const requestLayer = combineRequestLayer(request, boundaryOptions?.requestLayer?.(request))
    let response: Response | undefined
    let failurePolicyFailed = false
    let failurePolicyCause: unknown

    // Return a Result from the execution even after mapping it so Runtime can
    // classify typed failures and give request finalizers the original cause.
    // A policy defect is rethrown after this Result settles so it cannot replace
    // the typed failure supplied to the request Scope.
    // SAFETY: Public overloads validate the request Layer before this erased Runtime boundary.
    await executor.runWith(
      requestLayer as Layer.Any,
      async () => {
        const result = await program()

        if (Result.isError(result)) {
          try {
            response = assertResponse(await onFailure(result.error))
          } catch (cause) {
            failurePolicyFailed = true
            failurePolicyCause = cause
          }

          return Result.err(result.error)
        }

        response = assertResponse(
          await onSuccess({
            value: result.value
          })
        )
        return Result.ok(response)
      },
      { signal: request.signal }
    )

    if (failurePolicyFailed) {
      throw failurePolicyCause
    }

    if (response === undefined) {
      throw new Error('WebEffect response policy did not produce a Response')
    }

    return response
  }

  static streamWith<
    Provided extends AnyService,
    const Program extends AnyProgram,
    RequestLayer extends LayerInput,
    Failure = EffectError<Program>
  >(
    executor: RuntimeExecutor<Provided>,
    request: Request,
    program: Program,
    options: WebEffectStreamOptions<NoInfer<Failure>, RequestLayer> & {
      readonly requestLayer: (request: Request) => RequestLayer
    } & WebRequestLayerChecks<Provided, RequestLayer> &
      WebStreamProgramChecks<Provided, RequestLayer, Program, NoInfer<Failure>>
  ): Promise<Response>

  static streamWith<
    Provided extends AnyService,
    const Program extends AnyProgram,
    Failure = EffectError<Program>
  >(
    executor: RuntimeExecutor<Provided>,
    request: Request,
    program: Program &
      CompleteWebStreamProgram<Provided, DefaultRequestLayer, Program, NoInfer<Failure>>,
    options?: WebEffectStreamOptions<NoInfer<Failure>, DefaultRequestLayer>
  ): Promise<Response>

  static async streamWith(
    executor: RuntimeExecutor<AnyService>,
    request: Request,
    program: AnyProgram,
    options?: WebEffectStreamOptions<unknown, LayerInput>
  ): Promise<Response> {
    const timeoutMs = options?.unconsumedTimeoutMs ?? DEFAULT_UNCONSUMED_TIMEOUT_MS

    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError(
        'WebEffect stream unconsumedTimeoutMs must be a finite non-negative number'
      )
    }

    const onFailure = options?.onFailure ?? defaultFailure
    const requestLayer = combineRequestLayer(request, options?.requestLayer?.(request))
    const managedDeferred = deferred<RuntimeManagedExecution<unknown>>()

    const managedProgram = async (): Promise<RuntimeManagedPlan<Response>> => {
      const result = await program()

      if (Result.isError(result)) {
        const response = assertResponse(await onFailure(result.error))

        return {
          readiness: response,
          completion: Promise.reject(result.error),
          cancel: async () => {}
        }
      }

      const descriptor = assertStreamDescriptor(result.value)
      const body = makeManagedBody(descriptor, managedDeferred.promise, timeoutMs)
      const response = new Response(body.body, streamResponseInit(descriptor))

      body.start()

      return {
        readiness: response,
        completion: body.completion,
        cancel: body.cancel
      }
    }

    let managed: RuntimeManagedExecution<unknown> | undefined

    try {
      const currentManaged = executor.runWithManaged(
        requestLayer as Layer.Any,
        managedProgram as never,
        {
          signal: request.signal
        }
      )
      managed = currentManaged
      managedDeferred.resolve(currentManaged)
      const response = assertResponse(await currentManaged.readiness)
      void currentManaged.completion.catch(() => undefined)
      return response
    } catch (cause) {
      managedDeferred.reject(cause)
      if (managed !== undefined) {
        void managed.completion.catch(() => undefined)
        await managed.cancel(cause).catch(() => undefined)
      }
      throw cause
    }
  }
}

/** Type-level aliases for the framework-neutral Web boundary. */
export declare namespace WebEffect {
  /** Options used by `WebEffect.handleWith`. */
  export type Options<
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Success = unknown
  > = WebEffectOptions<Failure, RequestLayer, Success>

  /** The success value passed to `onSuccess`. */
  export type Success<A = unknown> = {
    readonly value: A
  }

  /** A standard Web response or an asynchronous response. */
  export type ResponseLike = Response | PromiseLike<Response>

  /** A lazy Result-valued Program accepted by `handleWith`. */
  export type Program<A = unknown, E = unknown, R extends AnyService = never> = WebEffectProgram<
    A,
    E,
    R
  >

  /** Extract a Program's success channel. */
  export type Value<Program extends WebEffectProgram<any, any, AnyService>> = EffectSuccess<Program>

  /** Extract a Program's typed failure channel. */
  export type Failure<Program extends WebEffectProgram<any, any, AnyService>> = EffectError<Program>

  /** Explicit response descriptor accepted by `streamWith`. */
  export type Stream = WebEffectStream

  /** Producer context accepted by a managed response descriptor. */
  export type StreamContext = WebEffectStreamContext

  /** Options used by `streamWith`. */
  export type StreamOptions<
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer
  > = WebEffectStreamOptions<Failure, RequestLayer>
}
