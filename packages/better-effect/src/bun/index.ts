import { Layer } from '../layer'
import { WebEffect } from '../web'
import type { AnyService } from '../service'
import type { LayerInput } from '../layer/inference'
import type { Runtime } from '../runtime'
import type {
  BunAnyProgram,
  BunEffectOptions,
  BunFetchHandler,
  BunHandlerProgram,
  BunRequestLayerChecks
} from './types'
import type { DefaultRequestLayer, WebEffectOptions } from '../web/types'

const runWebEffect = <Provided extends AnyService>(
  runtime: Runtime<Provided>,
  request: Request,
  program: BunAnyProgram,
  options: WebEffectOptions<unknown, LayerInput, unknown>
): Promise<Response> => {
  // SAFETY: BunHandlerFactory validates the Program; WebEffect owns this erased request boundary.
  return WebEffect.handle(runtime, request, program, options as never)
}

type BunHandlerFactory<
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Failure,
  WebSocketData,
  ProgramFactory extends (request: Request, server: Bun.Server<WebSocketData>) => BunAnyProgram
> = ProgramFactory &
  ([ReturnType<ProgramFactory>] extends [
    BunHandlerProgram<Provided, RequestLayer, ReturnType<ProgramFactory>, Failure>
  ]
    ? unknown
    : (
        request: Request,
        server: Bun.Server<WebSocketData>
      ) => BunHandlerProgram<Provided, RequestLayer, ReturnType<ProgramFactory>, Failure>)

/** Bind a Runtime and WebEffect policy to a Bun.serve fetch handler. */
export class BunEffect<
  Provided extends AnyService = never,
  Failure = unknown,
  RequestLayer extends LayerInput = DefaultRequestLayer
> {
  readonly runtime: Runtime<Provided>

  private readonly onSuccess: BunEffectOptions<Failure, RequestLayer>['onSuccess']

  private readonly onFailure: BunEffectOptions<Failure, RequestLayer>['onFailure']

  private readonly requestLayer: BunEffectOptions<Failure, RequestLayer>['requestLayer']

  private constructor(
    runtime: Runtime<Provided>,
    options: BunEffectOptions<Failure, RequestLayer>
  ) {
    this.runtime = runtime
    this.onSuccess = options.onSuccess
    this.onFailure = options.onFailure
    this.requestLayer = options.requestLayer
  }

  static make<
    Provided extends AnyService,
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer
  >(
    runtime: Runtime<Provided>,
    options?: BunEffectOptions<Failure, RequestLayer> &
      BunRequestLayerChecks<Provided, RequestLayer>
  ): BunEffect<Provided, Failure, RequestLayer> {
    return new BunEffect(runtime, options ?? {})
  }

  handler<
    WebSocketData = undefined,
    const ProgramFactory extends (
      request: Request,
      server: Bun.Server<WebSocketData>
    ) => BunAnyProgram = (request: Request, server: Bun.Server<WebSocketData>) => BunAnyProgram
  >(
    makeProgram: BunHandlerFactory<Provided, RequestLayer, Failure, WebSocketData, ProgramFactory>
  ): BunFetchHandler<WebSocketData> {
    return async (request, server) => {
      // SAFETY: the public factory check validates the returned Program before this erased wrapper.
      const program = (() => makeProgram(request, server)()) as BunAnyProgram

      return runWebEffect(this.runtime, request, program, this.makeWebOptions(request))
    }
  }

  private makeWebOptions(request: Request): WebEffectOptions<unknown, LayerInput, unknown> & {
    readonly requestLayer: (request: Request) => LayerInput
  } {
    type MutableWebOptions = {
      -readonly [Key in keyof WebEffectOptions<unknown, LayerInput, unknown>]?: WebEffectOptions<
        unknown,
        LayerInput,
        unknown
      >[Key]
    }
    const options: MutableWebOptions & {
      requestLayer: (request: Request) => LayerInput
    } = {
      requestLayer: this.requestLayer ?? (() => Layer.empty)
    }

    const onSuccess = this.onSuccess

    if (onSuccess !== undefined) {
      options.onSuccess = (result) => onSuccess(result, request)
    }

    const onFailure = this.onFailure

    if (onFailure !== undefined) {
      // SAFETY: the public handler check ties this wrapper to the configured Failure channel.
      options.onFailure = (error) => onFailure(error as Failure, request)
    }

    return options
  }
}

export type {
  BunEffectOptions,
  BunEffectProgram,
  BunFetchHandler,
  BunServer,
  ResponseLike
} from './types'
