/* oxlint-disable anti-slop/no-object-parameters -- private route boundaries erase framework context after public overload validation. */
/* oxlint-disable anti-slop/no-chained-type-assertions -- these are localized adapter erasures after overload checks. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below are confined to checked overload implementations. */

import { Effect } from '../effect'
import type { EffectSuccess, EffectYield, ProgramFromGenerator } from '../effect/types'
import type { CompleteInput, LayerInput, ProvidedEnvironment } from '../layer/inference'
import { Runtime } from '../runtime'
import type { RuntimeExecutor } from '../runtime'
import type { AnyService } from '../service'
import type {
  AnyProgram,
  AnyResult,
  DefaultRequestLayer,
  FromCurrentGeneratorChecks,
  FromCurrentHandlerFactory,
  FromCurrentRequirements,
  FromCurrentRequestLayerChecks,
  GeneratorBody,
  NextEffectContext,
  NextEffectManagedInspection,
  NextEffectManagedOptions,
  NextEffectOptions,
  NextEffectParams,
  NextEffectRouteOptions,
  NextEffectSuccess,
  NextEffectYieldable,
  NextRouteHandler
} from './types'
import { ManagedNextEffect } from './lifecycle'
import { makeNextRouteHandler } from './route-builder'

/** The two explicit ownership modes for the Next.js adapter. */
export class NextEffect {
  private constructor() {}

  /** Build an inert adapter whose handlers capture the current Runtime executor when yielded. */
  static fromCurrent<
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Context extends object = NextEffectContext
  >(
    options?: NextEffectOptions<Failure, RequestLayer, Context> &
      FromCurrentRequestLayerChecks<RequestLayer>
  ): NextEffect.FromCurrent<Failure, RequestLayer, Context> {
    return new FromCurrentNextEffect(options ?? {})
  }

  /** Build a host-owned adapter with one lazy Runtime for the supplied complete Layer. */
  static managed<
    Layer extends LayerInput,
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Context extends object = NextEffectContext
  >(
    layer: Layer & CompleteInput<Layer>,
    options?: NextEffectManagedOptions<Failure, RequestLayer, Context> &
      import('./types').NextRequestLayerChecks<ProvidedEnvironment<Layer>, RequestLayer>
  ): NextEffect.Managed<Layer, Failure, RequestLayer, Context> {
    return new ManagedNextEffect(layer, options ?? {})
  }
}

class FromCurrentNextEffect<Failure, RequestLayer extends LayerInput, Context extends object> {
  constructor(private readonly options: NextEffectOptions<Failure, RequestLayer, Context>) {}

  /** Materialize a route while resolving only the current Runtime executor. */
  handler<Program extends AnyProgram>(
    makeProgram: FromCurrentHandlerFactory<
      Context,
      Failure,
      (request: Request, context: Context) => Program
    >,
    options?: NextEffectRouteOptions<EffectSuccess<Program>, Context>
  ): NextEffectYieldable<NextRouteHandler<Context>, FromCurrentRequirements<Program, RequestLayer>>
  handler<
    const HandlerContext extends object,
    const ProgramFactory extends (request: Request, context: HandlerContext) => AnyProgram
  >(
    makeProgram: FromCurrentHandlerFactory<HandlerContext, Failure, ProgramFactory>,
    options?: NextEffectRouteOptions<EffectSuccess<ReturnType<ProgramFactory>>, HandlerContext>
  ): NextEffectYieldable<
    NextRouteHandler<HandlerContext>,
    FromCurrentRequirements<ReturnType<ProgramFactory>, RequestLayer>
  >
  handler(...args: unknown[]): any {
    const makeProgram = args[0] as (request: Request, context: object) => AnyProgram
    const options = (args[1] ?? {}) as NextEffectRouteOptions<unknown, object>

    return this.materialize((executor) =>
      makeNextRouteHandler(
        () => executor,
        this.options as unknown as NextEffectOptions<unknown, LayerInput, object>,
        makeProgram,
        options
      )
    )
  }

  /** Materialize a generator route while preserving its external Service requirements. */
  gen<
    const HandlerContext extends object = Context,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    body: GeneratorBody<HandlerContext, Yield, Returned> &
      FromCurrentGeneratorChecks<Yield, Returned, Failure>,
    options?: NextEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<Yield, Returned>>,
      HandlerContext
    >
  ): NextEffectYieldable<
    NextRouteHandler<HandlerContext>,
    FromCurrentRequirements<ProgramFromGenerator<Yield, Returned>, RequestLayer>
  >
  gen<
    const CustomContext extends object,
    const CustomYield extends EffectYield,
    const CustomReturned extends AnyResult
  >(
    body: GeneratorBody<CustomContext, CustomYield, CustomReturned> &
      FromCurrentGeneratorChecks<CustomYield, CustomReturned, Failure>,
    options?: NextEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<CustomYield, CustomReturned>>,
      CustomContext
    >
  ): NextEffectYieldable<
    NextRouteHandler<CustomContext>,
    FromCurrentRequirements<ProgramFromGenerator<CustomYield, CustomReturned>, RequestLayer>
  >
  gen(...args: unknown[]): any {
    const body = args[0] as GeneratorBody<object, EffectYield, AnyResult>
    const options = (args[1] ?? {}) as NextEffectRouteOptions<unknown, object>

    return this.materialize((executor) =>
      makeNextRouteHandler(
        () => executor,
        this.options as unknown as NextEffectOptions<unknown, LayerInput, object>,
        (request, context) =>
          Effect.fn(
            () => body(request, context) as AsyncGenerator<EffectYield, AnyResult, unknown>
          ) as AnyProgram,
        options
      )
    )
  }

  private materialize<Value>(
    build: (executor: RuntimeExecutor<AnyService>) => Value
  ): NextEffectYieldable<Value, AnyService> {
    return {
      *[Symbol.iterator]() {
        const executor = yield* Runtime.executor<AnyService>()
        return build(executor)
      },
      async *[Symbol.asyncIterator]() {
        const executor = yield* Runtime.executor<AnyService>()
        return build(executor)
      }
    }
  }
}

export declare namespace NextEffect {
  /** The inert embedded adapter returned by `fromCurrent`. */
  export type FromCurrent<
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Context extends object = NextEffectContext
  > = FromCurrentNextEffect<Failure, RequestLayer, Context>

  /** The host-owned adapter returned by `managed`. */
  export type Managed<
    Layer extends LayerInput,
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Context extends object = NextEffectContext
  > = ManagedNextEffect<Layer, Failure, RequestLayer, Context>

  /** Options shared by all handlers created from a NextEffect builder. */
  export type Options<
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Context extends object = NextEffectContext
  > = NextEffectOptions<Failure, RequestLayer, Context>

  /** Options for a host-owned managed adapter. */
  export type ManagedOptions<
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Context extends object = NextEffectContext
  > = NextEffectManagedOptions<Failure, RequestLayer, Context>

  /** The lifecycle inspection returned by a managed adapter. */
  export type ManagedInspection = NextEffectManagedInspection

  /** A typed per-route success policy. */
  export type RouteOptions<A, Context extends object = NextEffectContext> = NextEffectRouteOptions<
    A,
    Context
  >

  /** The explicit App Router context passed to route factories. */
  export type Context<Params extends object = NextEffectParams> = NextEffectContext<Params>

  /** The native handler returned by `handler` and `gen`. */
  export type Handler<Context extends object = NextEffectContext> = NextRouteHandler<Context>

  /** A native success policy value. */
  export type Success<A = unknown> = NextEffectSuccess<A>
}
