import { Result } from 'better-result'
import type { Context, Env, Handler, Input, MiddlewareHandler } from 'hono'

import { Effect } from '../effect'
import type { EffectSuccess, EffectYield, ProgramFromGenerator } from '../effect/types'
import { Runtime } from '../runtime'
import type { LayerInput } from '../layer/inference'
import type { AnyService } from '../service'
import {
  makeRequestBoundary,
  recordRequestFailure,
  recordRequestSuccess,
  type RequestState
} from './request-boundary'
import { defaultFailure, defaultSuccess } from './responses'
import type {
  AnyGeneratorBody,
  AnyHonoMiddleware,
  AnyProgram,
  AnyProgramFactory,
  AnyResult,
  AnyRouteOptions,
  AvailableServices,
  CompleteProgram,
  DefaultRequestLayer,
  GeneratorBody,
  GeneratorChecks,
  HonoContext,
  HonoEffectContext,
  HonoEffectOptions,
  HonoEffectRouteOptions,
  HonoRequestLayerChecks,
  MiddlewareEnvironment,
  MiddlewareInputs,
  MiddlewarePath
} from './types'

type HonoRouteArguments<Middlewares extends readonly AnyHonoMiddleware[], Body, Options> =
  | [...middlewares: Middlewares, body: Body]
  | [...middlewares: Middlewares, body: Body, options: Options | undefined]

type HonoInternalHandler = (
  context: HonoContext,
  next: () => Promise<void>
) => Promise<Response | void>

type HonoHandlerFactory<
  ContextType extends object,
  Provided extends AnyService,
  Failure,
  ProgramFactory extends (context: ContextType) => AnyProgram
> = ProgramFactory &
  ([ReturnType<ProgramFactory>] extends [
    CompleteProgram<Provided, ReturnType<ProgramFactory>, Failure>
  ]
    ? unknown
    : (context: ContextType) => CompleteProgram<Provided, ReturnType<ProgramFactory>, Failure>)

/** Run Effect Programs inside one Runtime execution per Hono request. */
export class HonoEffect<
  Provided extends AnyService = any,
  Failure = unknown,
  RequestLayer extends LayerInput = DefaultRequestLayer
> {
  readonly runtime: Runtime<Provided>

  private readonly states = new WeakMap<object, RequestState>()

  private readonly onSuccess: NonNullable<HonoEffectOptions<Failure, RequestLayer>['onSuccess']>

  private readonly onFailure: NonNullable<HonoEffectOptions<Failure, RequestLayer>['onFailure']>

  private readonly requestLayer: HonoEffectOptions<Failure, RequestLayer>['requestLayer']

  private constructor(
    runtime: Runtime<Provided>,
    options: HonoEffectOptions<Failure, RequestLayer>
  ) {
    this.runtime = runtime
    this.onSuccess = options.onSuccess ?? defaultSuccess
    this.onFailure = options.onFailure ?? defaultFailure
    this.requestLayer = options.requestLayer
  }

  static make<
    Provided extends AnyService,
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer
  >(
    runtime: Runtime<Provided>,
    options?: HonoEffectOptions<Failure, RequestLayer> &
      HonoRequestLayerChecks<Provided, RequestLayer>
  ): HonoEffect<Provided, Failure, RequestLayer> {
    return new HonoEffect(runtime, options ?? {})
  }

  middleware<E extends Env = Env, Path extends string = string>(): MiddlewareHandler<E, Path> {
    return makeRequestBoundary<Provided, RequestLayer, Failure, E, Path>({
      runtime: this.runtime,
      states: this.states,
      requestLayer: this.requestLayer,
      onSuccess: this.onSuccess,
      onFailure: this.onFailure
    })
  }

  handler<
    E extends Env = Env,
    Path extends string = string,
    InputType extends Input = Input,
    Program extends AnyProgram = AnyProgram
  >(
    makeProgram: (
      context: Context<E, Path, InputType>
    ) => CompleteProgram<AvailableServices<Provided, RequestLayer>, Program, Failure>,
    options?: HonoEffectRouteOptions<EffectSuccess<Program>, Context<E, Path, InputType>>
  ): Handler<E, Path, InputType, Promise<Response>>
  handler<
    const Middlewares extends readonly AnyHonoMiddleware[],
    E extends Env = MiddlewareEnvironment<Middlewares>,
    Path extends string = MiddlewarePath<Middlewares>,
    const ProgramFactory extends (
      context: HonoEffectContext<E, Path, MiddlewareInputs<Middlewares>>
    ) => AnyProgram = (
      context: HonoEffectContext<E, Path, MiddlewareInputs<Middlewares>>
    ) => AnyProgram
  >(
    ...args: HonoRouteArguments<
      Middlewares,
      HonoHandlerFactory<
        HonoEffectContext<E, Path, MiddlewareInputs<Middlewares>>,
        AvailableServices<Provided, RequestLayer>,
        Failure,
        ProgramFactory
      >,
      HonoEffectRouteOptions<
        EffectSuccess<ReturnType<ProgramFactory>>,
        Context<E, Path, MiddlewareInputs<Middlewares>>
      >
    >
  ): Handler<E, Path, MiddlewareInputs<Middlewares>, Promise<Response>>
  handler(...args: unknown[]): Handler<any, any, any, Promise<Response>> {
    const last = args.at(-1)
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- overload dispatch separates route options from function callbacks.
    const hasOptions = args.length > 1 && (last === undefined || typeof last !== 'function')
    // SAFETY: the overloads restrict the optional trailing argument to route options.
    const options = ((hasOptions ? last : {}) ?? {}) as AnyRouteOptions
    const bodyIndex = hasOptions ? args.length - 2 : args.length - 1
    // SAFETY: the overloads place the program factory immediately before route options.
    const makeProgram = args[bodyIndex] as AnyProgramFactory
    let handler = this.makeHandler(makeProgram, options)

    for (let index = bodyIndex - 1; index >= 0; index -= 1) {
      // SAFETY: every argument before the program factory is an input middleware by the overloads.
      handler = this.composeInputMiddleware(args[index] as AnyHonoMiddleware, handler)
    }

    // SAFETY: The public overload retains HonoEffect's Promise<Response> source contract; Hono also accepts the internal Promise<void> completion.
    return handler as Handler<any, any, any, Promise<Response>>
  }

  gen<
    E extends Env = Env,
    Path extends string = string,
    InputType extends Input = Input,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    body: GeneratorBody<Context<E, Path, InputType>, Yield, Returned> &
      GeneratorChecks<AvailableServices<Provided, RequestLayer>, Yield, Returned, Failure>,
    options?: HonoEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<Yield, Returned>>,
      Context<E, Path, InputType>
    >
  ): Handler<E, Path, InputType, Promise<Response>>
  gen<
    const Middlewares extends readonly AnyHonoMiddleware[],
    E extends Env = MiddlewareEnvironment<Middlewares>,
    Path extends string = MiddlewarePath<Middlewares>,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    ...args: HonoRouteArguments<
      Middlewares,
      GeneratorBody<HonoEffectContext<E, Path, MiddlewareInputs<Middlewares>>, Yield, Returned> &
        GeneratorChecks<AvailableServices<Provided, RequestLayer>, Yield, Returned, Failure>,
      HonoEffectRouteOptions<
        EffectSuccess<ProgramFromGenerator<Yield, Returned>>,
        Context<E, Path, MiddlewareInputs<Middlewares>>
      >
    >
  ): Handler<E, Path, MiddlewareInputs<Middlewares>, Promise<Response>>
  gen(...args: unknown[]): Handler<any, any, any, Promise<Response>> {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- overload dispatch distinguishes middleware from the generator body.
    const last = args.at(-1)
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- overload dispatch separates route options from function callbacks.
    const hasOptions = args.length > 1 && (last === undefined || typeof last !== 'function')
    // SAFETY: the overloads restrict the optional trailing argument to route options.
    const options = ((hasOptions ? last : {}) ?? {}) as AnyRouteOptions
    const bodyIndex = hasOptions ? args.length - 2 : args.length - 1
    // SAFETY: the overloads place the generator body immediately before route options.
    const body = args[bodyIndex] as AnyGeneratorBody

    let handler = this.makeHandler((context) => {
      // SAFETY: Effect.fn's runtime generator accepts both sync and async generators; the cast only joins its overloads.
      const program = Effect.fn(
        () => body(context) as AsyncGenerator<EffectYield, AnyResult, unknown>
      )

      // SAFETY: the public GeneratorChecks overload validates requirements before this erased boundary.
      return program as AnyProgram
    }, options)

    for (let index = bodyIndex - 1; index >= 0; index -= 1) {
      // SAFETY: every argument before the generator body is an input middleware by the overloads.
      handler = this.composeInputMiddleware(args[index] as AnyHonoMiddleware, handler)
    }

    // SAFETY: The public overload retains HonoEffect's Promise<Response> source contract; Hono also accepts the internal Promise<void> completion.
    return handler as Handler<any, any, any, Promise<Response>>
  }

  guard<
    E extends Env = Env,
    Path extends string = string,
    InputType extends Input = Input,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    body: GeneratorBody<Context<E, Path, InputType>, Yield, Returned> &
      GeneratorChecks<AvailableServices<Provided, RequestLayer>, Yield, Returned, Failure>
  ): MiddlewareHandler<E, Path> {
    return async (context, next) => {
      const state = this.getState(context)
      // SAFETY: Effect.fn accepts the sync or async generator supplied by the caller; this joins its overloads.
      const program = Effect.fn(() => body(context) as AsyncGenerator<Yield, Returned, unknown>)
      const result = await program()

      if (Result.isError(result)) {
        this.recordFailure(state, result.error)
        return
      }

      await next()
    }
  }

  private recordFailure(
    state: RequestState,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Result errors are intentionally opaque until the WebEffect policy narrows them.
    error: unknown
  ): void {
    recordRequestFailure(state, error)
  }

  private makeHandler(
    makeProgram: (context: HonoContext) => AnyProgram,
    options: HonoEffectRouteOptions<any, any>
  ): HonoInternalHandler {
    return async (context) => {
      const state = this.getState(context)
      const result = await makeProgram(context)()

      if (Result.isError(result)) {
        this.recordFailure(state, result.error)
        return
      }

      recordRequestSuccess(state, result.value, options)
    }
  }

  private composeInputMiddleware(
    inputMiddleware: AnyHonoMiddleware,
    handler: HonoInternalHandler
  ): HonoInternalHandler {
    return async (context, next) => {
      let downstreamResponse: Response | undefined
      let nextCalled = false

      // Match Hono's compose guard: a middleware may advance the chain only once.
      const nextOnce = async (): Promise<void> => {
        if (nextCalled) {
          throw new Error('next() called multiple times')
        }

        nextCalled = true
        const response = await handler(context, next)

        if (response !== undefined) {
          downstreamResponse = response
        }
      }
      const middlewareResponse = await inputMiddleware(context, nextOnce)

      if (middlewareResponse instanceof Response) {
        return middlewareResponse
      }

      if (downstreamResponse !== undefined) {
        return downstreamResponse
      }

      if (context.finalized) {
        return context.res
      }
    }
  }

  private getState(context: HonoContext): RequestState {
    const state = this.states.get(context)

    if (state === undefined) {
      throw new HonoEffectBoundaryMissingError()
    }

    return state
  }
}

export class HonoEffectBoundaryMissingError extends Error {
  constructor() {
    super('Register HonoEffect.middleware() before better-effect handlers')
    this.name = 'HonoEffectBoundaryMissingError'
  }
}
