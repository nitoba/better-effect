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
  HonoEffectContext,
  HonoEffectOptions,
  HonoEffectRouteOptions,
  HonoRequestLayerChecks,
  HonoEffectSuccess,
  MiddlewareEnvironment,
  ResponseLike,
  MiddlewareInput,
  MiddlewareInputs,
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
    options?: HonoEffectOptions<Failure, RequestLayer> &
      HonoRequestLayerChecks<Provided, RequestLayer>
  ): HonoEffect<Provided, Failure, RequestLayer> {
    return new HonoEffect(runtime, options ?? {})
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
    ) => CompleteProgram<AvailableServices<Provided, RequestLayer>, Program, Failure>,
    options?: HonoEffectRouteOptions<EffectSuccess<Program>, Context<E, Path, InputType>>
  ): Handler<E, Path, InputType, Promise<Response>>
  handler<
    const FirstMiddleware extends AnyHonoMiddleware,
    const SecondMiddleware extends AnyHonoMiddleware,
    E extends Env = MiddlewareEnvironment<FirstMiddleware>,
    Path extends string = MiddlewarePath<FirstMiddleware>,
    Program extends AnyProgram = AnyProgram
  >(
    firstMiddleware: FirstMiddleware,
    secondMiddleware: SecondMiddleware,
    makeProgram: (
      context: HonoEffectContext<E, Path, MiddlewareInputs<[FirstMiddleware, SecondMiddleware]>>
    ) => CompleteProgram<AvailableServices<Provided, RequestLayer>, Program, Failure>,
    options?: HonoEffectRouteOptions<
      EffectSuccess<Program>,
      Context<E, Path, MiddlewareInputs<[FirstMiddleware, SecondMiddleware]>>
    >
  ): Handler<E, Path, MiddlewareInputs<[FirstMiddleware, SecondMiddleware]>, Promise<Response>>
  handler<
    const FirstMiddleware extends AnyHonoMiddleware,
    const SecondMiddleware extends AnyHonoMiddleware,
    const ThirdMiddleware extends AnyHonoMiddleware,
    E extends Env = MiddlewareEnvironment<FirstMiddleware>,
    Path extends string = MiddlewarePath<FirstMiddleware>,
    Program extends AnyProgram = AnyProgram
  >(
    firstMiddleware: FirstMiddleware,
    secondMiddleware: SecondMiddleware,
    thirdMiddleware: ThirdMiddleware,
    makeProgram: (
      context: HonoEffectContext<
        E,
        Path,
        MiddlewareInputs<[FirstMiddleware, SecondMiddleware, ThirdMiddleware]>
      >
    ) => CompleteProgram<AvailableServices<Provided, RequestLayer>, Program, Failure>,
    options?: HonoEffectRouteOptions<
      EffectSuccess<Program>,
      Context<E, Path, MiddlewareInputs<[FirstMiddleware, SecondMiddleware, ThirdMiddleware]>>
    >
  ): Handler<
    E,
    Path,
    MiddlewareInputs<[FirstMiddleware, SecondMiddleware, ThirdMiddleware]>,
    Promise<Response>
  >
  handler<
    const InputMiddleware extends AnyHonoMiddleware,
    E extends Env = MiddlewareEnvironment<InputMiddleware>,
    Path extends string = MiddlewarePath<InputMiddleware>,
    Program extends AnyProgram = AnyProgram
  >(
    inputMiddleware: InputMiddleware,
    makeProgram: (
      context: HonoEffectContext<E, Path, MiddlewareInput<InputMiddleware>>
    ) => CompleteProgram<AvailableServices<Provided, RequestLayer>, Program, Failure>,
    options?: HonoEffectRouteOptions<
      EffectSuccess<Program>,
      Context<E, Path, MiddlewareInput<InputMiddleware>>
    >
  ): Handler<E, Path, MiddlewareInput<InputMiddleware>, Promise<Response>>
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

    return handler
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
    const FirstMiddleware extends AnyHonoMiddleware,
    const SecondMiddleware extends AnyHonoMiddleware,
    E extends Env = MiddlewareEnvironment<FirstMiddleware>,
    Path extends string = MiddlewarePath<FirstMiddleware>,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    firstMiddleware: FirstMiddleware,
    secondMiddleware: SecondMiddleware,
    body: GeneratorBody<
      HonoEffectContext<E, Path, MiddlewareInputs<[FirstMiddleware, SecondMiddleware]>>,
      Yield,
      Returned
    > &
      GeneratorChecks<AvailableServices<Provided, RequestLayer>, Yield, Returned, Failure>,
    options?: HonoEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<Yield, Returned>>,
      Context<E, Path, MiddlewareInputs<[FirstMiddleware, SecondMiddleware]>>
    >
  ): Handler<E, Path, MiddlewareInputs<[FirstMiddleware, SecondMiddleware]>, Promise<Response>>
  gen<
    const FirstMiddleware extends AnyHonoMiddleware,
    const SecondMiddleware extends AnyHonoMiddleware,
    const ThirdMiddleware extends AnyHonoMiddleware,
    E extends Env = MiddlewareEnvironment<FirstMiddleware>,
    Path extends string = MiddlewarePath<FirstMiddleware>,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    firstMiddleware: FirstMiddleware,
    secondMiddleware: SecondMiddleware,
    thirdMiddleware: ThirdMiddleware,
    body: GeneratorBody<
      HonoEffectContext<
        E,
        Path,
        MiddlewareInputs<[FirstMiddleware, SecondMiddleware, ThirdMiddleware]>
      >,
      Yield,
      Returned
    > &
      GeneratorChecks<AvailableServices<Provided, RequestLayer>, Yield, Returned, Failure>,
    options?: HonoEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<Yield, Returned>>,
      Context<E, Path, MiddlewareInputs<[FirstMiddleware, SecondMiddleware, ThirdMiddleware]>>
    >
  ): Handler<
    E,
    Path,
    MiddlewareInputs<[FirstMiddleware, SecondMiddleware, ThirdMiddleware]>,
    Promise<Response>
  >
  gen<
    const InputMiddleware extends AnyHonoMiddleware,
    E extends Env = MiddlewareEnvironment<InputMiddleware>,
    Path extends string = MiddlewarePath<InputMiddleware>,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    inputMiddleware: InputMiddleware,
    body: GeneratorBody<
      HonoEffectContext<E, Path, MiddlewareInput<InputMiddleware>>,
      Yield,
      Returned
    > &
      GeneratorChecks<AvailableServices<Provided, RequestLayer>, Yield, Returned, Failure>,
    options?: HonoEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<Yield, Returned>>,
      Context<E, Path, MiddlewareInput<InputMiddleware>>
    >
  ): Handler<E, Path, MiddlewareInput<InputMiddleware>, Promise<Response>>
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

    return handler
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
        return await this.handleFailure(state, result.error, context)
      }

      await next()
    }
  }

  private handleFailure(
    state: RequestState,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Result errors are intentionally opaque at this HTTP boundary.
    error: unknown,
    context: HonoContext
  ): ResponseLike {
    state.failure ??= { cause: error }
    // SAFETY: the public handler, gen, and guard constraints validate this error against Failure.
    return this.onFailure(error as Failure, context)
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
        return await this.handleFailure(state, result.error, context)
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
