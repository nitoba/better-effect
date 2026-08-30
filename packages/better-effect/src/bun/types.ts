import type { LayerInput } from '../layer/inference'
import type { AnyService } from '../service'
import type {
  AnyProgram,
  CompleteWebProgram,
  DefaultRequestLayer,
  WebEffectOptions,
  WebEffectProgram,
  WebEffectSuccess,
  WebRequestLayerChecks
} from '../web/types'

/** A Bun server passed to a Bun.serve fetch handler. */
export type BunServer<WebSocketData = undefined> = Bun.Server<WebSocketData>

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

/** Options for adapting a WebEffect boundary to Bun's fetch callback. */
export type BunEffectOptions<
  Failure = unknown,
  RequestLayer extends LayerInput = DefaultRequestLayer
> = Omit<WebEffectOptions<Failure, RequestLayer>, 'onFailure' | 'onSuccess'> & {
  /** Convert a successful Program value into a Response. */
  readonly onSuccess?: (result: WebEffectSuccess, request: Request) => ResponseLike
  /** Convert a typed Program failure into a Response. */
  readonly onFailure?: (error: Failure, request: Request) => ResponseLike
}

/** A standard Web response or an asynchronous response. */
export type ResponseLike = Response | PromiseLike<Response>

/** @internal */
export type BunAnyProgram = AnyProgram

/** @internal */
export type BunHandlerProgram<
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Program extends AnyProgram,
  Failure
> = CompleteWebProgram<Provided, RequestLayer, Program, Failure>

/** @internal */
export type BunRequestLayerChecks<
  Provided extends AnyService,
  RequestLayer extends LayerInput
> = WebRequestLayerChecks<Provided, RequestLayer>
