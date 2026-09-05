import { Result } from 'better-result'
import type { Context, Env, Handler, Input, MiddlewareHandler } from 'hono'

import { Effect } from '../effect'
import type {
  EffectSuccess,
  EffectYield,
  ProgramFromGenerator,
  ServiceRequirement
} from '../effect/types'
import type { LayerInput, RequiredEnvironment } from '../layer/inference'
import { Runtime } from '../runtime'
import { eraseRuntimeExecutor, type RuntimeExecutor } from '../runtime/executor'
import type { AnyService } from '../service'

import {
  makeRequestBoundary,
  recordRequestFailure,
  recordRequestSuccess,
  type RequestState
} from './request-boundary'
import { assertResponse } from '../web/responses'
import { defaultFailure, defaultSuccess } from './responses'
import type {
  AnyGeneratorBody,
  AnyHonoMiddleware,
  AnyProgram,
  AnyProgramFactory,
  AnyResult,
  AnyRouteOptions,
  CompleteProgram,
  GeneratorBody,
  GeneratorChecks,
  HonoContext,
  HonoEffectContext,
  HonoEffectOperation,
  HonoEffectOptions,
  HonoEffectRouteOptions,
  HonoEffectSuccess,
  HonoProgramRequirements,
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
  Failure,
  ProgramFactory extends (context: ContextType) => AnyProgram
> = ProgramFactory &
  ([ReturnType<ProgramFactory>] extends [CompleteProgram<ReturnType<ProgramFactory>, Failure>]
    ? unknown
    : (context: ContextType) => CompleteProgram<ReturnType<ProgramFactory>, Failure>)

type OperationFactory<A> = (executor: RuntimeExecutor<AnyService>) => A

/** Capture the active Runtime executor while a Hono application Layer is acquired. */
const makeOperation = <A, Requirements extends AnyService>(
  factory: OperationFactory<A>
): HonoEffectOperation<A, Requirements> => ({
  *[Symbol.iterator](): Generator<ServiceRequirement<Requirements>, A, unknown> {
    const executor = yield* Runtime.executor<Requirements>()
    return factory(eraseRuntimeExecutor(executor))
  },
  async *[Symbol.asyncIterator](): AsyncGenerator<ServiceRequirement<Requirements>, A, unknown> {
    const executor = yield* Runtime.executor<Requirements>()
    return factory(eraseRuntimeExecutor(executor))
  }
})

/** Build Hono-native handlers whose Runtime capability is captured by the app Layer. */
export class HonoEffectBuilder<Failure, RequestLayer extends LayerInput> {
  private readonly states = new WeakMap<object, RequestState>()

  private readonly onSuccess: NonNullable<HonoEffectOptions<Failure, RequestLayer>['onSuccess']>

  private readonly onFailure: NonNullable<HonoEffectOptions<Failure, RequestLayer>['onFailure']>

  private readonly requestLayer: HonoEffectOptions<Failure, RequestLayer>['requestLayer']

  constructor(options: HonoEffectOptions<Failure, RequestLayer>) {
    this.onSuccess = options.onSuccess ?? defaultSuccess
    this.onFailure = options.onFailure ?? defaultFailure
    this.requestLayer = options.requestLayer
  }

  middleware<E extends Env = Env, Path extends string = string>(): HonoEffectOperation<
    MiddlewareHandler<E, Path>,
    Extract<RequiredEnvironment<RequestLayer>, AnyService>
  > {
    return makeOperation((executor) =>
      makeRequestBoundary<Failure, RequestLayer, E, Path>({
        executor,
        states: this.states,
        requestLayer: this.requestLayer,
        onSuccess: this.onSuccess,
        onFailure: this.onFailure
      })
    )
  }

  handler<
    E extends Env = Env,
    Path extends string = string,
    InputType extends Input = Input,
    Program extends AnyProgram = AnyProgram
  >(
    makeProgram: (context: Context<E, Path, InputType>) => CompleteProgram<Program, Failure>,
    options?: HonoEffectRouteOptions<EffectSuccess<Program>, Context<E, Path, InputType>>
  ): HonoEffectOperation<
    Handler<E, Path, InputType, Promise<Response>>,
    HonoProgramRequirements<RequestLayer, Program>
  >
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
        Failure,
        ProgramFactory
      >,
      HonoEffectRouteOptions<
        EffectSuccess<ReturnType<ProgramFactory>>,
        Context<E, Path, MiddlewareInputs<Middlewares>>
      >
    >
  ): HonoEffectOperation<
    Handler<E, Path, MiddlewareInputs<Middlewares>, Promise<Response>>,
    HonoProgramRequirements<RequestLayer, ReturnType<ProgramFactory>>
  >
  handler(...args: unknown[]): HonoEffectOperation<any, AnyService> {
    const last = args.at(-1)
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- overload dispatch separates route options from function callbacks.
    const hasOptions = args.length > 1 && (last === undefined || typeof last !== 'function')
    // SAFETY: the overloads restrict the optional trailing argument to route options.
    const options = ((hasOptions ? last : {}) ?? {}) as AnyRouteOptions
    const bodyIndex = hasOptions ? args.length - 2 : args.length - 1
    // SAFETY: the overloads place the program factory immediately before route options.
    const makeProgram = args[bodyIndex] as AnyProgramFactory

    return makeOperation(() => {
      let handler = this.makeHandler(makeProgram, options)

      for (let index = bodyIndex - 1; index >= 0; index -= 1) {
        // SAFETY: every argument before the program factory is an input middleware by the overloads.
        handler = this.composeInputMiddleware(args[index] as AnyHonoMiddleware, handler)
      }

      // SAFETY: the public overload restores Hono's concrete handler channels after this erased implementation.
      return handler as Handler<any, any, any, Promise<Response>>
    })
  }

  gen<
    E extends Env = Env,
    Path extends string = string,
    InputType extends Input = Input,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    body: GeneratorBody<Context<E, Path, InputType>, Yield, Returned> &
      GeneratorChecks<Yield, Returned, Failure>,
    options?: HonoEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<Yield, Returned>>,
      Context<E, Path, InputType>
    >
  ): HonoEffectOperation<
    Handler<E, Path, InputType, Promise<Response>>,
    HonoProgramRequirements<RequestLayer, ProgramFromGenerator<Yield, Returned>>
  >
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
        GeneratorChecks<Yield, Returned, Failure>,
      HonoEffectRouteOptions<
        EffectSuccess<ProgramFromGenerator<Yield, Returned>>,
        Context<E, Path, MiddlewareInputs<Middlewares>>
      >
    >
  ): HonoEffectOperation<
    Handler<E, Path, MiddlewareInputs<Middlewares>, Promise<Response>>,
    HonoProgramRequirements<RequestLayer, ProgramFromGenerator<Yield, Returned>>
  >
  gen(...args: unknown[]): HonoEffectOperation<any, AnyService> {
    const last = args.at(-1)
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- overload dispatch distinguishes middleware from the generator body.
    const hasOptions = args.length > 1 && (last === undefined || typeof last !== 'function')
    // SAFETY: the overloads restrict the optional trailing argument to route options.
    const options = ((hasOptions ? last : {}) ?? {}) as AnyRouteOptions
    const bodyIndex = hasOptions ? args.length - 2 : args.length - 1
    // SAFETY: the overloads place the generator body immediately before route options.
    const body = args[bodyIndex] as AnyGeneratorBody

    return makeOperation(() => {
      let handler = this.makeHandler((context) => {
        // SAFETY: Effect.fn's runtime generator accepts both sync and async generators; the cast only joins its overloads.
        const program = Effect.fn(
          () => body(context) as AsyncGenerator<EffectYield, AnyResult, unknown>
        )

        // SAFETY: the public GeneratorChecks overload validates failures before this erased boundary.
        return program as AnyProgram
      }, options)

      for (let index = bodyIndex - 1; index >= 0; index -= 1) {
        // SAFETY: every argument before the generator body is an input middleware by the overloads.
        handler = this.composeInputMiddleware(args[index] as AnyHonoMiddleware, handler)
      }

      // SAFETY: the public overload restores Hono's concrete handler channels after this erased implementation.
      return handler as Handler<any, any, any, Promise<Response>>
    })
  }

  guard<
    E extends Env = Env,
    Path extends string = string,
    InputType extends Input = Input,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    body: GeneratorBody<Context<E, Path, InputType>, Yield, Returned> &
      GeneratorChecks<Yield, Returned, Failure>
  ): HonoEffectOperation<
    MiddlewareHandler<E, Path>,
    HonoProgramRequirements<RequestLayer, ProgramFromGenerator<Yield, Returned>>
  > {
    return makeOperation(() => async (context, next) => {
      const state = this.getState(context)
      // SAFETY: Effect.fn accepts the sync or async generator supplied by the caller; this joins its overloads.
      const program = Effect.fn(() => body(context) as AsyncGenerator<Yield, Returned, unknown>)
      const result = await program()

      if (Result.isError(result)) {
        return await this.handleFailure(state, result.error, context)
      }

      await next()
    })
  }

  private makeHandler(
    makeProgram: (context: HonoContext) => AnyProgram,
    options: HonoEffectRouteOptions<any, any>
  ): HonoInternalHandler {
    return async (context) => {
      const state = this.getState(context)
      const result = await makeProgram(context)()

      if (Result.isError(result)) {
        return await this.handleFailure(state, result.error, context)
      }

      recordRequestSuccess(state, result.value, options)
      return await this.handleSuccess(result.value, options, context)
    }
  }

  private async handleSuccess(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Route values are intentionally opaque until the Hono success policy consumes them.
    value: unknown,
    options: AnyRouteOptions,
    context: HonoContext
  ): Promise<Response> {
    if (options.respond !== undefined) {
      return assertResponse(await options.respond(value, context))
    }

    const success: HonoEffectSuccess = { value }

    if (options.status !== undefined) {
      Object.assign(success, { status: options.status })
    }

    if (options.serialize !== undefined) {
      Object.assign(success, { serialize: options.serialize })
    }

    return assertResponse(await this.onSuccess(success, context))
  }

  private async handleFailure(
    state: RequestState,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Result errors are intentionally opaque until the Hono failure policy consumes them.
    error: unknown,
    context: HonoContext
  ): Promise<Response> {
    recordRequestFailure(state, error)
    // SAFETY: the public handler, generator, and guard constraints validate this error against Failure.
    return assertResponse(await this.onFailure(error as Failure, context))
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
