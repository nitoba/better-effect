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
import type { ServiceTagOf } from '../service/types'
import type { CurrentRequest } from '../standard-services/current-request'
import type { Layer } from '../layer/layer'
import type { MissingDependencies } from '../internal/missing-dependencies'

/** A Web Response returned synchronously or asynchronously by a boundary policy. */
export type ResponseLike = Response | PromiseLike<Response>

/** JSON-compatible values accepted by the default Web success policy. */
export type WebJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly WebJsonValue[]
  | { readonly [key: string]: WebJsonValue }

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

/** @internal */
export type AnyProgram = WebEffectProgram<any, any, AnyService>

type IsAny<Type> = 0 extends 1 & Type ? true : false

type IsWidenedEnvironment<Provided extends AnyService> =
  IsAny<Provided> extends true ? true : string extends ServiceTagOf<Provided> ? true : false

/** @internal The request Layer installed by WebEffect when no custom Layer is supplied. */
export type DefaultRequestLayer = ReturnType<typeof CurrentRequest.layer>

/** @internal Services provided by a request Layer. */
export type RequestProvided<RequestLayer extends LayerInput> = ProvidedEnvironment<RequestLayer>

/** @internal Services available to a WebEffect Program. */
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

/** @internal Validate a custom request Layer against the Runtime and CurrentRequest. */
export type WebRequestLayerChecks<
  Provided extends AnyService,
  RequestLayer extends LayerInput
> = ValidateLayerInput<RequestLayer> &
  (IsWidenedEnvironment<Provided> extends true
    ? unknown
    : ValidateOneOverride<Layer<Provided, never>, RequestLayer>) &
  ValidateOneOverride<DefaultRequestLayer, RequestLayer> &
  ([RequestLayerMissing<Provided, RequestLayer>] extends [never]
    ? unknown
    : MissingDependencies<RequestLayerMissing<Provided, RequestLayer>>)

/** @internal Services missing from a WebEffect Program. */
export type WebProgramMissing<
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Program extends AnyProgram
> = ExecutionMissing<AvailableServices<Provided, RequestLayer>, Program>

/** @internal Validate a WebEffect Program's Services and typed failure channel. */
export type CompleteWebProgram<
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Program extends AnyProgram,
  Failure = unknown
> = Program & WebProgramChecks<Provided, RequestLayer, Program, Failure>

/** @internal Checks applied to a Program after the request Layer has been inferred. */
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
