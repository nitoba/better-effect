import { Result, type Result as ResultType } from 'better-result'
import { createMiddleware } from 'hono/factory'
import type { Context, Env, Handler, Input, MiddlewareHandler } from 'hono'

import { Effect } from '../effect'
import type {
  EffectSuccess,
  EffectYield,
  Program as ProgramType,
  ProgramFromGenerator
} from '../effect/types'
import { CurrentRequest } from '../standard-services'
import { Layer } from '../layer'
import type { LayerInput, ExecutionMissing, ProvidedEnvironment } from '../layer/inference'
import { Runtime } from '../runtime'
import type { AnyService } from '../service'
import type { MissingDependencies } from '../internal/missing-dependencies'

type AnyResult = ResultType<any, any>
type AnyProgram = ProgramType<any, any, AnyService>
type HonoContext = Context<any, any, any>
type ResponseLike = Response | Promise<Response>
type AnyHonoMiddleware = MiddlewareHandler<any, any, any, any>
type AnyProgramFactory = (context: HonoContext) => AnyProgram
type AnyRouteOptions = HonoEffectRouteOptions<any, any>
type MiddlewareInput<Middleware extends AnyHonoMiddleware> =
  Middleware extends MiddlewareHandler<any, any, infer InputType, any> ? InputType : Input
type MiddlewareEnvironment<Middleware extends AnyHonoMiddleware> =
  Middleware extends MiddlewareHandler<infer Environment, any, any, any> ? Environment : Env
type MiddlewarePath<Middleware extends AnyHonoMiddleware> =
  Middleware extends MiddlewareHandler<any, infer Path, any, any> ? Path : string
export type HonoJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly HonoJsonValue[]
  | { readonly [key: string]: HonoJsonValue }
type DefaultRequestLayer = ReturnType<typeof CurrentRequest.layer>
type RequestProvided<RequestLayer extends LayerInput> = ProvidedEnvironment<RequestLayer>
type AvailableServices<Provided extends AnyService, RequestLayer extends LayerInput> =
  | Provided
  | InstanceType<typeof CurrentRequest>
  | RequestProvided<RequestLayer>

type ProgramMissing<Provided extends AnyService, Program extends AnyProgram> = ExecutionMissing<
  Provided,
  Program
>

type CompleteProgram<Provided extends AnyService, Program extends AnyProgram> = [
  ProgramMissing<Provided, Program>
] extends [never]
  ? Program
  : Program & MissingDependencies<ProgramMissing<Provided, Program>>

type GeneratorBody<
  ContextType extends HonoContext,
  Yield extends EffectYield,
  Returned extends AnyResult
> = (
  context: ContextType
) => Generator<Yield, Returned, unknown> | AsyncGenerator<Yield, Returned, unknown>
type AnyGeneratorBody = GeneratorBody<HonoContext, EffectYield, AnyResult>

type GeneratorChecks<
  Provided extends AnyService,
  Yield extends EffectYield,
  Returned extends AnyResult
> = [ProgramMissing<Provided, ProgramFromGenerator<Yield, Returned>>] extends [never]
  ? unknown
  : MissingDependencies<ProgramMissing<Provided, ProgramFromGenerator<Yield, Returned>>>

export type HonoEffectSuccess<A = unknown> = {
  readonly value: A
  readonly status?: number
  readonly serialize?: (value: A) => HonoJsonValue
}

export type HonoEffectOptions<
  Failure = unknown,
  RequestLayer extends LayerInput = DefaultRequestLayer
> = {
  readonly onSuccess?: (result: HonoEffectSuccess<any>, context: HonoContext) => ResponseLike
  readonly onFailure?: (error: Failure, context: HonoContext) => ResponseLike
  readonly requestLayer?: (context: HonoContext) => RequestLayer
}

export type HonoEffectRouteOptions<A, ContextType extends HonoContext = HonoContext> = {
  readonly status?: number
  readonly serialize?: (value: A) => HonoJsonValue
  readonly respond?: (value: A, context: ContextType) => ResponseLike
}

export class HonoEffectBoundaryMissingError extends Error {
  constructor() {
    super('Register HonoEffect.middleware() before better-effect handlers')
    this.name = 'HonoEffectBoundaryMissingError'
  }
}

type RequestState = {
  failure?: {
    readonly cause: unknown
  }
}

const defaultSuccess = (
  { value, status, serialize }: HonoEffectSuccess,
  context: HonoContext
): Response => {
  if (value instanceof Response) {
    return value
  }

  const body = serialize === undefined ? value : serialize(value)

  if (body === undefined) {
    // SAFETY: route status is intentionally configurable and Hono validates it at response construction.
    return context.body(null, (status ?? 204) as never)
  }

  if (status === undefined) {
    return context.json({ data: body })
  }

  // SAFETY: route status is intentionally configurable and Hono validates it at response construction.
  return context.json({ data: body }, status as never)
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Result errors are intentionally opaque at this HTTP boundary.
const defaultFailure = (error: unknown, context: HonoContext): Response => {
  if (error instanceof Response) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)

  return context.json({ error: message }, 500)
}

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
    // SAFETY: createMiddleware preserves the Hono handler contract; only the generic Context is restored here.
    return createMiddleware(async (context, next) => {
      const key = context
      const existing = this.states.get(key)

      if (existing !== undefined) {
        await next()
        return
      }

      const state: RequestState = {}
      this.states.set(key, state)

      try {
        const requestLayer = CurrentRequest.layer(context.req.raw)
        const customLayer = this.requestLayer?.(context)
        // SAFETY: a custom request Layer extends or intentionally overrides the built-in CurrentRequest provider.
        const layer =
          customLayer === undefined
            ? requestLayer
            : Layer.override(requestLayer, customLayer as never)

        // SAFETY: request Layers are supplied by this adapter and execute inside the Runtime's typed boundary.
        await this.runtime.runWith(
          layer as never,
          async () => {
            try {
              await next()
            } catch (cause) {
              state.failure ??= { cause }
            }

            if (state.failure !== undefined) {
              return Result.err(state.failure.cause)
            }

            if (context.error !== undefined) {
              return Result.err(context.error)
            }

            return Result.ok(context.res)
          },
          { signal: context.req.raw.signal }
        )
      } finally {
        this.states.delete(key)
      }
    }) as MiddlewareHandler<E, Path>
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

export type { HonoContext }
