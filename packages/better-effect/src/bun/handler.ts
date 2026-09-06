import type { ServiceRequirement } from '../effect/types'
import { Runtime } from '../runtime'
import { eraseRuntimeExecutor, type RuntimeExecutor } from '../runtime/executor'
import type { AnyService } from '../service'
import { WebEffect } from '../web'
import type { DefaultRequestLayer } from '../web/types'
import type { LayerInput } from '../layer/inference'

import type {
  BunAnyProgram,
  BunEffectOperation,
  BunEffectOptions,
  BunFetchHandler,
  BunHandlerFactory,
  BunHandlerRequirements,
  BunRequestLayerChecks,
  ResponseLike
} from './types'

type HandlerArguments<
  RequestLayer extends LayerInput,
  Failure,
  WebSocketData,
  ProgramFactory extends (request: Request, server: Bun.Server<WebSocketData>) => BunAnyProgram
> =
  | [
      options: BunEffectOptions<Failure, RequestLayer>,
      makeProgram: BunHandlerFactory<Failure, WebSocketData, ProgramFactory>
    ]
  | [makeProgram: BunHandlerFactory<Failure, WebSocketData, ProgramFactory>]

type OperationFactory<A> = (executor: RuntimeExecutor<AnyService>) => A

type BunBoundaryResult = {
  readonly value: unknown
}

interface BunBoundaryOptions<RequestLayer extends LayerInput> {
  requestLayer?: (request: Request) => RequestLayer
  onSuccess?: (result: BunBoundaryResult) => ResponseLike
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- WebEffect failure values are opaque until the typed public policy consumes them.
  onFailure?: (error: unknown) => ResponseLike
}

const makeOperation = <A, Requirements extends AnyService>(
  factory: OperationFactory<A>
): BunEffectOperation<A, Requirements> => ({
  *[Symbol.iterator](): Generator<ServiceRequirement<Requirements>, A, unknown> {
    const executor = yield* Runtime.executor<Requirements>()
    return factory(eraseRuntimeExecutor(executor))
  },
  async *[Symbol.asyncIterator](): AsyncGenerator<ServiceRequirement<Requirements>, A, unknown> {
    const executor = yield* Runtime.executor<Requirements>()
    return factory(eraseRuntimeExecutor(executor))
  }
})

const makeBoundaryOptions = <Failure, RequestLayer extends LayerInput>(
  options: BunEffectOptions<Failure, RequestLayer>,
  request: Request
): BunBoundaryOptions<RequestLayer> => {
  const boundaryOptions: BunBoundaryOptions<RequestLayer> = {}

  if (options.requestLayer !== undefined) {
    boundaryOptions.requestLayer = () => options.requestLayer!(request)
  }

  if (options.onSuccess !== undefined) {
    boundaryOptions.onSuccess = (result) => options.onSuccess!(result, request)
  }

  if (options.onFailure !== undefined) {
    // SAFETY: WebEffect's failure channel is erased here and was checked by BunHandlerFactory at the public boundary.
    boundaryOptions.onFailure = (error) => options.onFailure!(error as Failure, request)
  }

  return boundaryOptions
}

const makeHandler =
  <
    Failure,
    RequestLayer extends LayerInput,
    WebSocketData,
    const ProgramFactory extends (
      request: Request,
      server: Bun.Server<WebSocketData>
    ) => BunAnyProgram
  >(
    executor: RuntimeExecutor<AnyService>,
    options: BunEffectOptions<Failure, RequestLayer>,
    factory: ProgramFactory
  ): BunFetchHandler<WebSocketData> =>
  async (request, server) => {
    const program = () => factory(request, server)()

    // SAFETY: BunHandlerFactory validates the lazy Program before this erased WebEffect boundary.
    const boundaryProgram = program as BunAnyProgram
    // SAFETY: BunBoundaryOptions is structurally compatible with WebEffect's erased policy callbacks.
    const boundaryOptions = makeBoundaryOptions(options, request) as never
    return await WebEffect.handleWith(executor, request, boundaryProgram, boundaryOptions)
  }

/** Build Bun fetch handlers whose Runtime capability is captured by a Layer. */
export const makeBunHandler = <
  RequestLayer extends LayerInput = DefaultRequestLayer,
  Failure = unknown,
  WebSocketData = undefined,
  const ProgramFactory extends (
    request: Request,
    server: Bun.Server<WebSocketData>
  ) => BunAnyProgram = (request: Request, server: Bun.Server<WebSocketData>) => BunAnyProgram
>(
  ...args: HandlerArguments<RequestLayer, Failure, WebSocketData, ProgramFactory> &
    BunRequestLayerChecks<RequestLayer>
): BunEffectOperation<
  BunFetchHandler<WebSocketData>,
  BunHandlerRequirements<RequestLayer, ReturnType<ProgramFactory>>
> => {
  const first = args[0]
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- overload dispatch distinguishes the options object from the factory.
  const isFactory = typeof first === 'function'
  const options = isFactory ? {} : first
  // SAFETY: The overload tuple places the Program factory in this position.
  const factory = (isFactory ? first : args[1]) as ProgramFactory

  // SAFETY: makeOperation's erased implementation is restored to the validated public requirement channels.
  return makeOperation((executor) => {
    // SAFETY: HandlerArguments and BunRequestLayerChecks validate this erased options object.
    return makeHandler(executor, options as BunEffectOptions<Failure, RequestLayer>, factory)
  }) as BunEffectOperation<
    BunFetchHandler<WebSocketData>,
    BunHandlerRequirements<RequestLayer, ReturnType<ProgramFactory>>
  >
}
