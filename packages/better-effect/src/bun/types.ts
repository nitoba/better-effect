import type {
  EffectError,
  EffectRequirements,
  InferYieldRequirements,
  ServiceRequirement
} from '../effect/types'
import type {
  LayerInput,
  LayerResult,
  MissingServices,
  ProvidedEnvironment,
  RequiredEnvironment,
  ValidateLayerInput,
  ValidateOneOverride
} from '../layer/inference'
import type { ProviderEntry } from '../layer/metadata'
import type {
  AnyService,
  ServiceContract,
  ServiceRequirements,
  ServiceToken,
  ServiceIdentity
} from '../service'
import type { CurrentRequest } from '../standard-services/current-request'
import type {
  DefaultRequestLayer,
  WebEffectOptions,
  WebEffectProgram,
  WebEffectSuccess
} from '../web/types'

/** A Bun server passed to a Bun.serve fetch handler. */
export type BunServer<WebSocketData = undefined> = Bun.Server<WebSocketData>

/** Options accepted by the public Bun.serve API. */
export type BunServeOptions<
  WebSocketData = undefined,
  Route extends string = string
> = Bun.Serve.Options<WebSocketData, Route>

/** The Promise<Response> handler shape accepted by Bun.serve. */
export type BunFetchHandler<WebSocketData = undefined> = (
  request: Request,
  server: BunServer<WebSocketData>
) => Promise<Response>

/** A lazy Result-valued Program accepted by the Bun adapter. */
export type BunEffectProgram<
  A = unknown,
  E = unknown,
  R extends AnyService = never
> = WebEffectProgram<A, E, R>

/** A standard Web response or an asynchronous response. */
export type ResponseLike = Response | PromiseLike<Response>

/** Options used by `BunEffect.handler`. */
export type BunEffectOptions<
  Failure = unknown,
  RequestLayer extends LayerInput = DefaultRequestLayer,
  Success = unknown
> = Omit<WebEffectOptions<Failure, RequestLayer, Success>, 'onFailure' | 'onSuccess'> & {
  /** Convert a successful Program value into a Response. */
  readonly onSuccess?: (result: WebEffectSuccess<Success>, request: Request) => ResponseLike
  /** Convert a typed Program failure into a Response. */
  readonly onFailure?: (error: Failure, request: Request) => ResponseLike
}

/** A yieldable operation acquired from a Bun Layer. */
export interface BunEffectOperation<A, Requirements extends AnyService = never> {
  readonly [Symbol.iterator]: () => Generator<ServiceRequirement<Requirements>, A, unknown>
  readonly [Symbol.asyncIterator]: () => AsyncGenerator<
    ServiceRequirement<Requirements>,
    A,
    unknown
  >
}

type FailureCheck<Failure, Actual> = [Actual] extends [Failure]
  ? unknown
  : {
      readonly __betterEffectInvalidBunFailure: {
        readonly actual: Actual
        readonly expected: Failure
      }
    }

/** Validate a Bun Program's typed failure channel at the handler boundary. */
export type BunProgramChecks<Program extends BunAnyProgram, Failure = unknown> = FailureCheck<
  Failure,
  EffectError<Program>
>

/** Validate a request Layer against Bun's built-in CurrentRequest provider. */
export type BunRequestLayerChecks<RequestLayer extends LayerInput> =
  ValidateLayerInput<RequestLayer> & ValidateOneOverride<DefaultRequestLayer, RequestLayer>

/** Services that a handler's enclosing Layer must provide. */
export type BunHandlerRequirements<
  RequestLayer extends LayerInput,
  Program extends BunAnyProgram
> = Extract<
  | RequiredEnvironment<RequestLayer>
  | MissingServices<
      Extract<EffectRequirements<Program>, AnyService>,
      Extract<InstanceType<typeof CurrentRequest> | ProvidedEnvironment<RequestLayer>, AnyService>
    >,
  AnyService
>

/** A Bun handler Program factory with its typed failure contract checked. */
export type BunHandlerFactory<
  Failure,
  WebSocketData,
  ProgramFactory extends (request: Request, server: BunServer<WebSocketData>) => BunAnyProgram
> = ProgramFactory &
  ([ReturnType<ProgramFactory>] extends [BunProgramChecks<ReturnType<ProgramFactory>, Failure>]
    ? unknown
    : (
        request: Request,
        server: BunServer<WebSocketData>
      ) => ReturnType<ProgramFactory> & BunProgramChecks<ReturnType<ProgramFactory>, Failure>)

/** A Layer-first Bun server factory returning native Bun.serve options. */
export type BunServerFactory<
  WebSocketData = undefined,
  Route extends string = string,
  Yield extends ServiceRequirement<any> = ServiceRequirement<any>
> = () =>
  | Generator<Yield, BunServeOptions<WebSocketData, Route>, unknown>
  | AsyncGenerator<Yield, BunServeOptions<WebSocketData, Route>, unknown>

/** The result of a custom Bun Service Layer factory. */
export type BunServerLayerSpec<
  Service extends ServiceToken<any, any>,
  WebSocketData = undefined,
  Route extends string = string
> = {
  readonly options: BunServeOptions<WebSocketData, Route>
  readonly map: (
    server: BunServer<WebSocketData>
  ) => ServiceContract<InstanceType<Service>> | PromiseLike<ServiceContract<InstanceType<Service>>>
}

/** A Layer-first Bun server factory for an application-owned Service token. */
export type BunServerLayerFactory<
  Service extends ServiceToken<any, any>,
  WebSocketData = undefined,
  Route extends string = string,
  Yield extends ServiceRequirement<any> = ServiceRequirement<any>
> = () =>
  | Generator<Yield, BunServerLayerSpec<Service, WebSocketData, Route>, unknown>
  | AsyncGenerator<Yield, BunServerLayerSpec<Service, WebSocketData, Route>, unknown>

type BunServerFactoryResult<Factory> = Factory extends (...arguments_: any[]) => infer Iterator
  ? Iterator extends Generator<any, infer Result, any>
    ? Result
    : Iterator extends AsyncGenerator<any, infer Result, any>
      ? Result
      : never
  : never

type DefaultBunServerData<Data> = unknown extends Data ? undefined : Data
type DefaultBunServerRoute<Route> = unknown extends Route ? string : Route

/** @internal Infer the native Bun server data generic from a server factory. */
export type InferBunServerData<Factory> =
  BunServerFactoryResult<Factory> extends Bun.Serve.Options<infer Data, infer _Route extends string>
    ? DefaultBunServerData<Data>
    : undefined

/** @internal Infer the native Bun route generic from a server factory. */
export type InferBunServerRoute<Factory> =
  BunServerFactoryResult<Factory> extends Bun.Serve.Options<infer _Data, infer Route extends string>
    ? DefaultBunServerRoute<Route>
    : string

/** @internal Prefer an explicit data generic, otherwise infer it from options. */
export type BunServerDataFor<Explicit, Factory> = [Explicit] extends [never]
  ? InferBunServerData<Factory>
  : Explicit

/** @internal Prefer an explicit route generic, otherwise infer it from options. */
export type BunServerRouteFor<Explicit extends string, Factory> = [Explicit] extends [never]
  ? InferBunServerRoute<Factory>
  : Explicit

/** @internal Validate explicit server generics without blocking factory inference. */
export type BunServerFactoryCheck<ExplicitData, ExplicitRoute extends string, Factory> = [
  ExplicitData
] extends [never]
  ? unknown
  : Factory extends BunServerFactory<ExplicitData, BunServerRouteFor<ExplicitRoute, Factory>>
    ? unknown
    : {
        readonly __betterEffectInvalidBunServerFactory: {
          readonly data: ExplicitData
          readonly route: ExplicitRoute
        }
      }

/** A Layer that provides the Service selected by `BunEffect.layer`. */
export type BunEffectLayer<
  Service extends ServiceToken<any, any>,
  Yield extends ServiceRequirement<any>
> = LayerResult<
  ProviderEntry<
    InstanceType<Service>,
    Extract<ServiceRequirements<InstanceType<Service>> | InferYieldRequirements<Yield>, AnyService>
  >
>

/** A generated raw Bun server token with its Layer attached. */
export type BunServerToken<
  Tag extends string,
  WebSocketData,
  _Route extends string,
  Yield extends ServiceRequirement<any>
> = ServiceToken<Tag, BunServer<WebSocketData> & ServiceIdentity<Tag>> & {
  readonly layer: BunEffectLayer<
    ServiceToken<Tag, BunServer<WebSocketData> & ServiceIdentity<Tag>>,
    Yield
  >
}

/** @internal */
export type BunAnyProgram = WebEffectProgram<any, any, AnyService>

/** @internal */
export type BunLiteralTag<Tag extends string> = string extends Tag
  ? never
  : Tag extends ''
    ? never
    : Tag

/** @internal */
export type InferGeneratorYield<Factory> = Factory extends (...arguments_: any[]) => infer Iterator
  ? Iterator extends Generator<infer Yield, any, any>
    ? Yield
    : Iterator extends AsyncGenerator<infer Yield, any, any>
      ? Yield
      : never
  : never
