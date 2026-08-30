import type { Result as ResultType } from 'better-result'

import type { EffectError, Program as ProgramType } from '../effect/types'
import type {
  ExecutionMissing,
  LayerInput,
  MissingServices,
  ProvidedEnvironment,
  RequiredEnvironment,
  ValidateLayerInput,
  ValidateOneOverride
} from '../layer/inference'
import type { AnyService } from '../service'
import type { CurrentRequest } from '../standard-services'
import type { MissingDependencies } from '../internal/missing-dependencies'

/** A Web Response returned synchronously or asynchronously by a boundary policy. */
export type ResponseLike = Response | PromiseLike<Response>

/** The value passed to a WebEffect success policy. */
export type WebEffectSuccess<A = unknown> = {
  readonly value: A
}

/** A lazy Program type accepted by the WebEffect boundary. */
export type WebEffectProgram<A = unknown, E = unknown, R extends AnyService = never> = ProgramType<
  A,
  E,
  R
>

export type AnyResult = ResultType<any, any>
export type AnyProgram = WebEffectProgram<any, any, AnyService>

/** The request Layer installed by WebEffect when no custom Layer is supplied. */
export type DefaultRequestLayer = ReturnType<typeof CurrentRequest.layer>

/** Services provided by a request Layer. */
export type RequestProvided<RequestLayer extends LayerInput> = ProvidedEnvironment<RequestLayer>

/** Services available to a WebEffect Program. */
export type AvailableServices<Provided extends AnyService, RequestLayer extends LayerInput> =
  | Provided
  | InstanceType<typeof CurrentRequest>
  | RequestProvided<RequestLayer>

type InvalidFailure<Actual, Expected> = {
  readonly __betterEffectInvalidWebFailure: {
    readonly actual: Actual
    readonly expected: Expected
  }
}

type FailureCheck<Failure, Actual> = [Actual] extends [Failure]
  ? unknown
  : InvalidFailure<Actual, Failure>

type RequestLayerMissing<
  Provided extends AnyService,
  RequestLayer extends LayerInput
> = MissingServices<
  Extract<RequiredEnvironment<RequestLayer>, AnyService>,
  Extract<Provided | InstanceType<typeof CurrentRequest>, AnyService>
>

/** Validate a custom request Layer against the Runtime and CurrentRequest. */
export type WebRequestLayerChecks<
  Provided extends AnyService,
  RequestLayer extends LayerInput
> = ValidateLayerInput<RequestLayer> &
  ValidateOneOverride<DefaultRequestLayer, RequestLayer> &
  ([RequestLayerMissing<Provided, RequestLayer>] extends [never]
    ? unknown
    : MissingDependencies<RequestLayerMissing<Provided, RequestLayer>>)

/** Services missing from a WebEffect Program. */
export type WebProgramMissing<
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Program extends AnyProgram
> = ExecutionMissing<AvailableServices<Provided, RequestLayer>, Program>

/** Validate a WebEffect Program's Services and typed failure channel. */
export type CompleteWebProgram<
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Program extends AnyProgram,
  Failure = unknown
> = Program & WebProgramChecks<Provided, RequestLayer, Program, Failure>

/** Checks applied to a Program after the request Layer has been inferred. */
export type WebProgramChecks<
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Program extends AnyProgram,
  Failure = unknown
> = (WebProgramMissing<Provided, RequestLayer, Program> extends never
  ? unknown
  : MissingDependencies<WebProgramMissing<Provided, RequestLayer, Program>>) &
  FailureCheck<NoInfer<Failure>, EffectError<Program>>

/** Options for converting a WebEffect Result into a standard Response. */
export type WebEffectOptions<
  Failure = unknown,
  RequestLayer extends LayerInput = DefaultRequestLayer,
  Success = unknown
> = {
  /** Build a request-local Layer. It is evaluated once for each Request. */
  readonly requestLayer?: (request: Request) => RequestLayer
  /** Convert a successful Program value into a Response. */
  readonly onSuccess?: (result: WebEffectSuccess<Success>) => ResponseLike
  /** Convert a typed Program failure into a Response. */
  readonly onFailure?: (error: Failure) => ResponseLike
}

/** A type-level view of a WebEffect boundary's request-layer contract. */
export type WebEffectRequestLayer<
  Provided extends AnyService,
  RequestLayer extends LayerInput
> = WebRequestLayerChecks<Provided, RequestLayer>

/** A type-level view of a WebEffect boundary's failure contract. */
export type WebEffectFailureCheck<Failure, Actual> = FailureCheck<Failure, Actual>
