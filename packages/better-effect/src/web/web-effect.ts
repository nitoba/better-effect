import { Result } from 'better-result'

import { Layer } from '../layer'
import type { LayerInput } from '../layer/inference'
import { CurrentRequest } from '../standard-services/current-request'
import type { Runtime } from '../runtime'
import type { AnyService } from '../service'
import type { EffectError, EffectSuccess } from '../effect/types'
import { assertResponse, defaultFailure, defaultSuccess } from './responses'
import type {
  AnyProgram,
  CompleteWebProgram,
  DefaultRequestLayer,
  WebEffectOptions,
  WebEffectProgram,
  WebProgramChecks,
  WebRequestLayerChecks
} from './types'

const combineRequestLayer = <RequestLayer extends LayerInput>(
  request: Request,
  customLayer: RequestLayer | undefined
): LayerInput => {
  const currentRequestLayer = CurrentRequest.layer(request)

  if (customLayer === undefined) {
    return currentRequestLayer
  }

  // SAFETY: WebEffect.handle validates the custom Layer's shape and override contract at its public boundary.
  return Layer.override(currentRequestLayer, customLayer as never)
}

/** Execute one Result-valued Program inside a framework-neutral Web request boundary. */
export class WebEffect {
  private constructor() {}

  /**
   * Run one lazy Program and map its Result to a standard Web Response.
   *
   * The request Layer and execution Scope are owned by the supplied Runtime;
   * request resources close before this Promise resolves, while Runtime-root
   * resources remain owned by the Runtime.
   */
  static handle<
    Provided extends AnyService,
    const Program extends AnyProgram,
    RequestLayer extends LayerInput,
    Failure = EffectError<Program>
  >(
    runtime: Runtime<Provided>,
    request: Request,
    program: Program,
    options: WebEffectOptions<NoInfer<Failure>, RequestLayer, EffectSuccess<Program>> & {
      readonly requestLayer: (request: Request) => RequestLayer
    } & WebRequestLayerChecks<Provided, RequestLayer> &
      WebProgramChecks<Provided, RequestLayer, Program, NoInfer<Failure>>
  ): Promise<Response>

  static handle<
    Provided extends AnyService,
    const Program extends AnyProgram,
    Failure = EffectError<Program>
  >(
    runtime: Runtime<Provided>,
    request: Request,
    program: Program & CompleteWebProgram<Provided, DefaultRequestLayer, Program, NoInfer<Failure>>,
    options: WebEffectOptions<NoInfer<Failure>, DefaultRequestLayer, EffectSuccess<Program>>
  ): Promise<Response>

  static handle<Provided extends AnyService, const Program extends AnyProgram>(
    runtime: Runtime<Provided>,
    request: Request,
    program: Program & CompleteWebProgram<Provided, DefaultRequestLayer, Program>,
    options?: undefined
  ): Promise<Response>

  static async handle(
    runtime: Runtime<AnyService>,
    request: Request,
    program: AnyProgram,
    options?: WebEffectOptions<unknown, LayerInput, unknown>
  ): Promise<Response> {
    const boundaryOptions = options
    const onSuccess = boundaryOptions?.onSuccess ?? defaultSuccess
    const onFailure = boundaryOptions?.onFailure ?? defaultFailure
    const requestLayer = combineRequestLayer(request, boundaryOptions?.requestLayer?.(request))
    let response: Response | undefined

    // Return a Result from the execution even after mapping it so Runtime can
    // classify typed failures and give request finalizers the original cause.
    // SAFETY: Public overloads validate the request Layer before this erased Runtime boundary.
    await runtime.runWith(
      requestLayer as Layer.Any,
      async () => {
        const result = await program()

        if (Result.isError(result)) {
          response = assertResponse(await onFailure(result.error))
          return Result.err(result.error)
        }

        response = assertResponse(
          await onSuccess({
            value: result.value
          })
        )
        return Result.ok(response)
      },
      { signal: request.signal }
    )

    if (response === undefined) {
      throw new Error('WebEffect response policy did not produce a Response')
    }

    return response
  }
}

/** Type-level aliases for the framework-neutral Web boundary. */
export declare namespace WebEffect {
  /** Options used by `WebEffect.handle`. */
  export type Options<
    Failure = unknown,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Success = unknown
  > = WebEffectOptions<Failure, RequestLayer, Success>

  /** The success value passed to `onSuccess`. */
  export type Success<A = unknown> = {
    readonly value: A
  }

  /** A standard Web response or an asynchronous response. */
  export type ResponseLike = Response | PromiseLike<Response>

  /** A lazy Result-valued Program accepted by `handle`. */
  export type Program<A = unknown, E = unknown, R extends AnyService = never> = WebEffectProgram<
    A,
    E,
    R
  >

  /** Extract a Program's success channel. */
  export type Value<Program extends WebEffectProgram<any, any, AnyService>> = EffectSuccess<Program>

  /** Extract a Program's typed failure channel. */
  export type Failure<Program extends WebEffectProgram<any, any, AnyService>> = EffectError<Program>
}
