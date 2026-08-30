/* oxlint-disable anti-slop/no-object-parameters -- the private boundary erases arbitrary framework context types after public overload validation. */
/* oxlint-disable anti-slop/no-unknown-parameters -- response policy values are opaque until WebEffect validates them. */
/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- the private WebEffect options object is populated only by checked policies. */

import { Result } from 'better-result'

import { Effect } from '../effect'
import type { EffectSuccess, EffectYield, ProgramFromGenerator } from '../effect/types'
import type { LayerInput } from '../layer/inference'
import type { Runtime } from '../runtime'
import type { AnyService } from '../service'
import { WebEffect } from '../web'
import type {
  AnyProgram,
  AnyResult,
  DefaultRequestLayer,
  GeneratorBody,
  NextEffectContext,
  NextEffectOptions,
  NextEffectParams,
  NextEffectRouteOptions,
  NextGeneratorChecks,
  CompleteNextProgram,
  NextHandlerFactory,
  NextRequestLayerChecks,
  NextRouteHandler
} from './types'

const routeSuccessPolicyNames = ['respond', 'serialize', 'onSuccess'] as const

const assertExclusiveRouteSuccessPolicy = (
  options: NextEffectRouteOptions<unknown, object>
): void => {
  const configuredPolicies = routeSuccessPolicyNames.filter((name) => options[name] !== undefined)

  if (configuredPolicies.length > 1) {
    throw new TypeError(
      `NextEffect route options must configure at most one success policy; received ${configuredPolicies.join(', ')}`
    )
  }
}

/** Run Result-valued Programs inside one Runtime boundary per Next request. */
export class NextEffect<
  Provided extends AnyService = AnyService,
  Failure = unknown,
  RequestLayer extends LayerInput = DefaultRequestLayer,
  Context extends object = NextEffectContext
> {
  readonly runtime: Runtime<Provided>

  private readonly onSuccess: NextEffectOptions<Failure, RequestLayer, Context>['onSuccess']

  private readonly onFailure: NextEffectOptions<Failure, RequestLayer, Context>['onFailure']

  private readonly requestLayer: NextEffectOptions<Failure, RequestLayer, Context>['requestLayer']

  private constructor(
    runtime: Runtime<Provided>,
    options: NextEffectOptions<Failure, RequestLayer, Context>
  ) {
    this.runtime = runtime
    this.onSuccess = options.onSuccess
    this.onFailure = options.onFailure
    this.requestLayer = options.requestLayer
  }

  /** Bind an application-owned Runtime to App Router Route Handler factories. */
  static make<
    Provided extends AnyService,
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Context extends object = NextEffectContext
  >(
    runtime: Runtime<Provided>,
    options?: NextEffectOptions<Failure, RequestLayer, Context> &
      NextRequestLayerChecks<Provided, RequestLayer>
  ): NextEffect<Provided, Failure, RequestLayer, Context> {
    return new NextEffect(runtime, options ?? {})
  }

  /** Create a native Route Handler from an explicit Request/context Program factory. */
  handler<Program extends AnyProgram>(
    makeProgram: (
      request: Request,
      context: Context
    ) => CompleteNextProgram<Provided, RequestLayer, Program, Failure>,
    options?: NextEffectRouteOptions<EffectSuccess<Program>, Context>
  ): NextRouteHandler<Context>
  handler<
    const HandlerContext extends object,
    const ProgramFactory extends (request: Request, context: HandlerContext) => AnyProgram
  >(
    makeProgram: NextHandlerFactory<
      HandlerContext,
      Provided,
      RequestLayer,
      Failure,
      ProgramFactory
    >,
    options?: NextEffectRouteOptions<EffectSuccess<ReturnType<ProgramFactory>>, HandlerContext>
  ): NextRouteHandler<HandlerContext>
  handler(...args: unknown[]): NextRouteHandler<object> {
    // SAFETY: The public overloads restrict the first argument to a checked Program factory.
    const makeProgram = args[0] as (request: Request, context: object) => AnyProgram
    // SAFETY: The public overloads restrict the optional second argument to route options.
    const options = (args[1] ?? {}) as NextEffectRouteOptions<unknown, object>

    return this.makeHandler(makeProgram, options)
  }

  /** Create a native Route Handler from a Request/context generator body. */
  gen<
    const HandlerContext extends object = Context,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    body: GeneratorBody<HandlerContext, Yield, Returned> &
      NextGeneratorChecks<Provided, RequestLayer, Yield, Returned, Failure>,
    options?: NextEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<Yield, Returned>>,
      HandlerContext
    >
  ): NextRouteHandler<HandlerContext>
  gen<
    const CustomContext extends object,
    const CustomYield extends EffectYield,
    const CustomReturned extends AnyResult
  >(
    body: GeneratorBody<CustomContext, CustomYield, CustomReturned> &
      NextGeneratorChecks<Provided, RequestLayer, CustomYield, CustomReturned, Failure>,
    options?: NextEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<CustomYield, CustomReturned>>,
      CustomContext
    >
  ): NextRouteHandler<CustomContext>
  gen(...args: unknown[]): NextRouteHandler<object> {
    // SAFETY: The public overloads restrict the first argument to a checked generator body.
    const body = args[0] as GeneratorBody<object, EffectYield, AnyResult>
    // SAFETY: The public overloads restrict the optional second argument to route options.
    const options = (args[1] ?? {}) as NextEffectRouteOptions<unknown, object>

    return this.makeHandler((request, context) => {
      // SAFETY: Effect.fn accepts the sync or async generator supplied by the public overload.
      const program = Effect.fn(
        // SAFETY: The public overloads accept both sync and async generator bodies; the runtime invokes the resulting Program asynchronously.
        () => body(request, context) as AsyncGenerator<EffectYield, AnyResult, unknown>
      )

      // SAFETY: The public overloads validate the generator's Result, failure, and Service channels.
      return program as AnyProgram
    }, options)
  }

  private makeHandler(
    makeProgram: (request: Request, context: object) => AnyProgram,
    routeOptions: NextEffectRouteOptions<unknown, object>
  ): NextRouteHandler<object> {
    assertExclusiveRouteSuccessPolicy(routeOptions)

    return async (request, context) => {
      const program = makeProgram(request, context)
      const shouldSerialize = routeOptions.serialize !== undefined
      const effectiveProgram = shouldSerialize
        ? async () => {
            const result = await program()

            if (Result.isError(result)) {
              return result
            }

            return Result.ok(routeOptions.serialize!(result.value, request, context))
          }
        : program
      const webOptions: Record<string, unknown> = {}

      if (this.requestLayer !== undefined) {
        // SAFETY: The public handler overloads pair this runtime context with the configured Context type.
        webOptions.requestLayer = () => this.requestLayer!(request, context as Context)
      }

      if (routeOptions.respond !== undefined) {
        webOptions.onSuccess = ({ value }: { readonly value: unknown }) =>
          routeOptions.respond!(value, request, context)
      } else if (routeOptions.onSuccess !== undefined) {
        webOptions.onSuccess = (result: { readonly value: unknown }) =>
          routeOptions.onSuccess!(result, request, context)
      } else if (this.onSuccess !== undefined) {
        webOptions.onSuccess = (result: { readonly value: unknown }) => {
          // SAFETY: The public handler overloads pair this runtime context with the configured Context type.
          return this.onSuccess!(result, request, context as Context)
        }
      }

      if (this.onFailure !== undefined) {
        webOptions.onFailure = (error: unknown) => {
          // SAFETY: Runtime WebEffect failures are the checked Failure channel of the route Program.
          return this.onFailure!(error as Failure, request, context as Context)
        }
      }

      // SAFETY: Public overloads validate the Program, request Layer, Failure, and Response policy before this erased WebEffect call.
      return await WebEffect.handle(
        // SAFETY: The Runtime's concrete Service union is intentionally erased for WebEffect's internal heterogeneous boundary.
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- this is the adapter's single generic erasure.
        this.runtime as unknown as Runtime<AnyService>,
        request,
        // SAFETY: The effective Program is either the checked Program or a private serializer wrapper that preserves its Result error channel.
        effectiveProgram as AnyProgram,
        // SAFETY: The erased WebEffect options are built exclusively from the validated route policies above.
        webOptions as never
      )
    }
  }
}

export declare namespace NextEffect {
  /** Options shared by all handlers created from a bound Runtime. */
  export type Options<
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Context extends object = NextEffectContext
  > = NextEffectOptions<Failure, RequestLayer, Context>

  /** A typed per-route success policy. */
  export type RouteOptions<A, Context extends object = NextEffectContext> = NextEffectRouteOptions<
    A,
    Context
  >

  /** The explicit App Router context passed to route factories. */
  export type Context<Params extends object = NextEffectParams> = NextEffectContext<Params>

  /** The native handler returned by `handler` and `gen`. */
  export type Handler<Context extends object = NextEffectContext> = NextRouteHandler<Context>
}
