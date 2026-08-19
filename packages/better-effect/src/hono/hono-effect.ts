import { Result } from 'better-result'
import type { Context, Env, Handler, Input, MiddlewareHandler } from 'hono'

import { Effect } from '../effect'
import type { EffectSuccess, EffectYield, ProgramFromGenerator } from '../effect/types'
import { Runtime } from '../runtime'
import type { LayerInput } from '../layer/inference'
import type { AnyService } from '../service'
import { makeRequestBoundary, type RequestState } from './request-boundary'
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
  HonoEffectOptions,
  HonoEffectRouteOptions,
  HonoEffectSuccess,
  MiddlewareEnvironment,
  MiddlewareInput,
  MiddlewarePath
} from './types'

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
    options: HonoEffectOptions<Failure, RequestLayer> = {}
  ): HonoEffect<Provided, Failure, RequestLayer> {
    return new HonoEffect(runtime, options)
  }

  middleware<E extends Env = Env, Path extends string = string>(): MiddlewareHandler<E, Path> {
    return makeRequestBoundary<Provided, RequestLayer, E, Path>({
      runtime: this.runtime,
      states: this.states,
      requestLayer: this.requestLayer
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
    ) => CompleteProgram<AvailableServices<Provided, RequestLayer>, Program>,
    options?: HonoEffectRouteOptions<EffectSuccess<Program>, Context<E, Path, InputType>>
  ): Handler<E, Path, InputType, Promise<Response>>
  handler<
    const InputMiddleware extends AnyHonoMiddleware,
    E extends Env = MiddlewareEnvironment<InputMiddleware>,
    Path extends string = MiddlewarePath<InputMiddleware>,
    Program extends AnyProgram = AnyProgram
  >(
    inputMiddleware: InputMiddleware,
    makeProgram: (
      context: Context<E, Path, MiddlewareInput<InputMiddleware>>
    ) => CompleteProgram<AvailableServices<Provided, RequestLayer>, Program>,
    options?: HonoEffectRouteOptions<
      EffectSuccess<Program>,
      Context<E, Path, MiddlewareInput<InputMiddleware>>
    >
  ): Handler<E, Path, MiddlewareInput<InputMiddleware>, Promise<Response>>
  handler(
    first: AnyHonoMiddleware | AnyProgramFactory,
    second?: AnyProgramFactory | AnyRouteOptions,
    third?: AnyRouteOptions
  ): Handler<any, any, any, Promise<Response>> {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- overload dispatch distinguishes middleware from the program factory.
    if (typeof second === 'function') {
      // SAFETY: the function-valued second argument identifies the first argument as the input middleware overload.
      const inputMiddleware = first as AnyHonoMiddleware
      // SAFETY: the function-valued second argument is the program factory overload.
      const makeProgram = second as AnyProgramFactory

      return this.composeInputMiddleware(
        inputMiddleware,
        this.makeHandler(makeProgram, third ?? {})
      )
    }

    // SAFETY: without a function-valued second argument, the first argument is the program factory overload.
    const makeProgram = first as AnyProgramFactory
    // SAFETY: without a function-valued second argument, the second argument is route options.
    const options = second as AnyRouteOptions | undefined

    return this.makeHandler(makeProgram, options ?? {})
  }

  gen<
    E extends Env = Env,
    Path extends string = string,
    InputType extends Input = Input,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    body: GeneratorBody<Context<E, Path, InputType>, Yield, Returned> &
      GeneratorChecks<AvailableServices<Provided, RequestLayer>, Yield, Returned>,
    options?: HonoEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<Yield, Returned>>,
      Context<E, Path, InputType>
    >
  ): Handler<E, Path, InputType, Promise<Response>>
  gen<
    const InputMiddleware extends AnyHonoMiddleware,
    E extends Env = MiddlewareEnvironment<InputMiddleware>,
    Path extends string = MiddlewarePath<InputMiddleware>,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    inputMiddleware: InputMiddleware,
    body: GeneratorBody<Context<E, Path, MiddlewareInput<InputMiddleware>>, Yield, Returned> &
      GeneratorChecks<AvailableServices<Provided, RequestLayer>, Yield, Returned>,
    options?: HonoEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<Yield, Returned>>,
      Context<E, Path, MiddlewareInput<InputMiddleware>>
    >
  ): Handler<E, Path, MiddlewareInput<InputMiddleware>, Promise<Response>>
  gen(
    first: AnyHonoMiddleware | AnyGeneratorBody,
    second?: AnyGeneratorBody | AnyRouteOptions,
    third?: AnyRouteOptions
  ): Handler<any, any, any, Promise<Response>> {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- overload dispatch distinguishes middleware from the generator body.
    const hasInputMiddleware = typeof second === 'function'
    let inputMiddleware: AnyHonoMiddleware | undefined
    let body: AnyGeneratorBody
    let options: AnyRouteOptions | undefined

    if (hasInputMiddleware) {
      // SAFETY: a function-valued second argument identifies the first argument as input middleware.
      inputMiddleware = first as AnyHonoMiddleware
      // SAFETY: a function-valued second argument is the generator body overload.
      body = second as AnyGeneratorBody
      options = third
    } else {
      // SAFETY: without a function-valued second argument, the first argument is the generator body overload.
      body = first as AnyGeneratorBody
      // SAFETY: without a function-valued second argument, the second argument is route options.
      options = second as AnyRouteOptions | undefined
    }

    const handler = this.makeHandler((context) => {
      // SAFETY: Effect.fn's runtime generator accepts both sync and async generators; the cast only joins its overloads.
      const program = Effect.fn(
        () => body(context) as AsyncGenerator<EffectYield, AnyResult, unknown>
      )

      // SAFETY: the public GeneratorChecks overload validates requirements before this erased boundary.
      return program as AnyProgram
    }, options ?? {})

    return inputMiddleware === undefined
      ? handler
      : this.composeInputMiddleware(inputMiddleware, handler)
  }

  guard<
    E extends Env = Env,
    Path extends string = string,
    InputType extends Input = Input,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    body: GeneratorBody<Context<E, Path, InputType>, Yield, Returned> &
      GeneratorChecks<AvailableServices<Provided, RequestLayer>, Yield, Returned>
  ): MiddlewareHandler<E, Path> {
    return async (context, next) => {
      const state = this.getState(context)
      // SAFETY: Effect.fn accepts the sync or async generator supplied by the caller; this joins its overloads.
      const program = Effect.fn(() => body(context) as AsyncGenerator<Yield, Returned, unknown>)
      const result = await program()

      if (Result.isError(result)) {
        state.failure ??= { cause: result.error }
        // SAFETY: the configured failure policy is the boundary for this guard's Result error channel.
        return await this.onFailure(result.error as Failure, context)
      }

      await next()
    }
  }

  private makeHandler(
    makeProgram: (context: HonoContext) => AnyProgram,
    options: HonoEffectRouteOptions<any, any>
  ): Handler<any, any, any, Promise<Response>> {
    return async (context) => {
      const state = this.getState(context)
      const program = makeProgram(context)
      const result = await program()

      if (Result.isError(result)) {
        state.failure ??= { cause: result.error }
        // SAFETY: the configured failure policy is the boundary for this Program's Result error channel.
        return await this.onFailure(result.error as Failure, context)
      }

      const value = result.value

      if (options.respond !== undefined) {
        return await options.respond(value, context)
      }

      const success: HonoEffectSuccess<any> = { value }

      if (options.status !== undefined) {
        Object.assign(success, { status: options.status })
      }

      if (options.serialize !== undefined) {
        Object.assign(success, { serialize: options.serialize })
      }

      return await this.onSuccess(success, context)
    }
  }

  private composeInputMiddleware(
    inputMiddleware: AnyHonoMiddleware,
    handler: Handler<any, any, any, Promise<Response>>
  ): Handler<any, any, any, Promise<Response>> {
    return async (context, next) => {
      let downstreamResponse: Response | undefined

      const middlewareResponse = await inputMiddleware(context, async () => {
        downstreamResponse = await handler(context, next)
      })

      if (middlewareResponse instanceof Response) {
        return middlewareResponse
      }

      if (downstreamResponse !== undefined) {
        return downstreamResponse
      }

      return context.res
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
