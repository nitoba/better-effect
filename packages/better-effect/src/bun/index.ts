import { Service } from '../service'
import type { AnyService, ServiceIdentity, ServiceToken } from '../service'
import type { LayerInput } from '../layer/inference'
import type { DefaultRequestLayer } from '../web/types'

import { makeBunHandler } from './handler'
import { makeBunLayer, makeBunServer } from './server'
import type {
  BunAnyProgram,
  BunEffectLayer,
  BunEffectOperation,
  BunEffectOptions,
  BunFetchHandler,
  BunHandlerFactory,
  BunHandlerRequirements,
  BunLiteralTag,
  BunRequestLayerChecks,
  BunServer,
  BunServerFactory,
  BunServerFactoryCheck,
  BunServerLayerFactory,
  BunServerToken,
  BunServerDataFor,
  BunServerRouteFor,
  InferGeneratorYield
} from './types'

/** Layer-first Bun integration for effectful handlers and owned servers. */
export class BunEffect {
  private constructor() {}

  /** Build a fetch handler by capturing the active Runtime executor. */
  static handler<
    WebSocketData = undefined,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Failure = unknown,
    const ProgramFactory extends (
      request: Request,
      server: Bun.Server<WebSocketData>
    ) => BunAnyProgram = (request: Request, server: Bun.Server<WebSocketData>) => BunAnyProgram
  >(
    options: BunEffectOptions<Failure, RequestLayer> & BunRequestLayerChecks<RequestLayer>,
    makeProgram: BunHandlerFactory<Failure, WebSocketData, ProgramFactory>
  ): BunEffectOperation<
    BunFetchHandler<WebSocketData>,
    BunHandlerRequirements<RequestLayer, ReturnType<ProgramFactory>>
  >

  static handler<
    WebSocketData = undefined,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Failure = unknown,
    const ProgramFactory extends (
      request: Request,
      server: Bun.Server<WebSocketData>
    ) => BunAnyProgram = (request: Request, server: Bun.Server<WebSocketData>) => BunAnyProgram
  >(
    makeProgram: BunHandlerFactory<Failure, WebSocketData, ProgramFactory>
  ): BunEffectOperation<
    BunFetchHandler<WebSocketData>,
    BunHandlerRequirements<RequestLayer, ReturnType<ProgramFactory>>
  >

  static handler(...args: unknown[]): BunEffectOperation<unknown, AnyService> {
    // SAFETY: The overloads validate the argument tuple before this erased implementation.
    return makeBunHandler(...(args as never)) as BunEffectOperation<unknown, AnyService>
  }

  /** Create a raw Bun server Service and its lifecycle-owning Layer. */
  static server<
    const Tag extends string,
    WebSocketData = never,
    Route extends string = never,
    const Factory extends BunServerFactory<any, any> = BunServerFactory<any, any>
  >(
    tag: Tag & BunLiteralTag<Tag>,
    factory: Factory & BunServerFactoryCheck<WebSocketData, Route, Factory>
  ): BunServerToken<
    Tag,
    BunServerDataFor<WebSocketData, Factory>,
    BunServerRouteFor<Route, Factory>,
    InferGeneratorYield<Factory>
  > {
    type Data = BunServerDataFor<WebSocketData, Factory>
    type RouteType = BunServerRouteFor<Route, Factory>
    const tokenFactory = Service<BunServer<Data> & ServiceIdentity<Tag>>()<Tag>(tag)
    // SAFETY: Service() returns the class-backed token; this assertion restores the exact Bun server contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const token = tokenFactory as unknown as ServiceToken<
      Tag,
      BunServer<Data> & ServiceIdentity<Tag>
    >
    // SAFETY: The factory check validates explicit generics; inferred Data and Route come from its native Bun options.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const typedFactory = factory as unknown as BunServerFactory<Data, RouteType>
    const built = makeBunServer<Tag, Data, RouteType, typeof typedFactory, typeof token>(
      typedFactory,
      token
    )

    Object.defineProperty(built.token, 'layer', {
      configurable: false,
      enumerable: true,
      value: built.layer,
      writable: false
    })

    // SAFETY: makeBunServer constructs the matching token and Layer pair for these exact generic arguments.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    return built.token as unknown as BunServerToken<
      Tag,
      Data,
      RouteType,
      InferGeneratorYield<Factory>
    >
  }

  /** Provide an application-chosen Service token backed by a native Bun server. */
  static layer<
    Service extends ServiceToken<any, any>,
    WebSocketData = undefined,
    Route extends string = string,
    const Factory extends BunServerLayerFactory<Service, WebSocketData, Route> =
      BunServerLayerFactory<Service, WebSocketData, Route>
  >(service: Service, factory: Factory): BunEffectLayer<Service, InferGeneratorYield<Factory>> {
    return makeBunLayer<Service, WebSocketData, Route, typeof factory>(service, factory)
  }
}

export type {
  BunEffectLayer,
  BunEffectOperation,
  BunEffectOptions,
  BunEffectProgram,
  BunFetchHandler,
  BunHandlerFactory,
  BunHandlerRequirements,
  BunRequestLayerChecks,
  BunServer,
  BunServerFactory,
  BunServerLayerFactory,
  BunServerLayerSpec,
  BunServerToken,
  BunServeOptions,
  ResponseLike
} from './types'
