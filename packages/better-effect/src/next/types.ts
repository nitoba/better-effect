import type { Result as ResultType } from 'better-result'

import type {
  EffectError,
  EffectRequirements,
  EffectYield,
  Program as ProgramType,
  ProgramFromGenerator,
  ServiceRequirement
} from '../effect/types'
import type {
  ExecutionMissing,
  LayerInput,
  MissingServices,
  ProvidedEnvironment,
  RequiredEnvironment,
  ValidateLayerInput,
  ValidateOneOverride
} from '../layer/inference'
import type { RuntimeInspection, RuntimeOptions } from '../runtime'
import type { AnyService } from '../service'
import type { MissingDependencies } from '../internal/missing-dependencies'
import type { CurrentRequest } from '../standard-services/current-request'
import type { WebJsonValue, WebRequestLayerChecks } from '../web/types'

/** Route parameters exposed by Next.js App Router contexts. */
export type NextEffectParams = {
  readonly [key: string]: string | readonly string[] | undefined
}

/** The explicit context passed to an App Router Route Handler factory. */
export type NextEffectContext<Params extends object = NextEffectParams> = {
  readonly params: Promise<Params>
}

/** A native Route Handler function returned by this adapter. */
export type NextRouteHandler<Context extends object = NextEffectContext> = (
  request: Request,
  context: Context
) => Promise<Response>

/** A native Web Response returned synchronously or asynchronously by a policy. */
export type ResponseLike = Response | PromiseLike<Response>

/** The value passed to a Next success policy. */
export type NextEffectSuccess<A = unknown> = {
  readonly value: A
}

/** A lazy Result-valued Program accepted by the Next boundary. */
export type NextEffectProgram<A = unknown, E = unknown, R extends AnyService = never> = ProgramType<
  A,
  E,
  R
>

/** @internal */
export type AnyProgram = NextEffectProgram<any, any, AnyService>

/** @internal */
export type AnyResult = ResultType<any, any>

/** The request Layer installed when no custom Layer is supplied. */
export type DefaultRequestLayer = ReturnType<typeof CurrentRequest.layer>

/** Services available to a route Program after its request Layer is installed. */
export type AvailableServices<Provided extends AnyService, RequestLayer extends LayerInput> =
  | Provided
  | InstanceType<typeof CurrentRequest>
  | ProvidedEnvironment<RequestLayer>

/** Validate a request Layer against a managed Runtime and CurrentRequest. */
export type NextRequestLayerChecks<
  Provided extends AnyService,
  RequestLayer extends LayerInput
> = WebRequestLayerChecks<Provided, RequestLayer>

/** Validate a request Layer for the embedded mode, whose root environment is external. */
export type FromCurrentRequestLayerChecks<RequestLayer extends LayerInput> =
  ValidateLayerInput<RequestLayer> & ValidateOneOverride<DefaultRequestLayer, RequestLayer>

type InvalidFailure<Actual, Expected> = {
  readonly __betterEffectInvalidNextFailure: {
    readonly actual: Actual
    readonly expected: Expected
  }
}

type FailureCheck<Failure, Actual> = [Actual] extends [Failure]
  ? unknown
  : InvalidFailure<Actual, Failure>

/** Services supplied by the embedded request boundary itself. */
type RequestBoundaryServices<RequestLayer extends LayerInput> = Extract<
  InstanceType<typeof CurrentRequest> | ProvidedEnvironment<RequestLayer>,
  AnyService
>

/** Requirements that must be supplied by the Runtime containing a fromCurrent builder. */
export type FromCurrentRequirements<
  Program extends AnyProgram,
  RequestLayer extends LayerInput
> = MissingServices<
  Extract<EffectRequirements<Program> | RequiredEnvironment<RequestLayer>, AnyService>,
  RequestBoundaryServices<RequestLayer>
>

/** Services and failures checked for one managed route Program. */
export type NextProgramChecks<
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Program extends AnyProgram,
  Failure = unknown
> = (ExecutionMissing<AvailableServices<Provided, RequestLayer>, Program> extends never
  ? unknown
  : MissingDependencies<ExecutionMissing<AvailableServices<Provided, RequestLayer>, Program>>) &
  FailureCheck<Failure, EffectError<Program>>

/** A route Program after its Service and Failure channels have been checked. */
export type CompleteNextProgram<
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Program extends AnyProgram,
  Failure = unknown
> = Program & NextProgramChecks<Provided, RequestLayer, Program, Failure>

/** Convert a managed route Program factory into a checked factory. */
export type NextHandlerFactory<
  Context extends object,
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Failure,
  ProgramFactory extends (request: Request, context: Context) => AnyProgram
> = ProgramFactory &
  ([ReturnType<ProgramFactory>] extends [
    CompleteNextProgram<Provided, RequestLayer, ReturnType<ProgramFactory>, Failure>
  ]
    ? unknown
    : (
        request: Request,
        context: Context
      ) => CompleteNextProgram<Provided, RequestLayer, ReturnType<ProgramFactory>, Failure>)

/** Convert an embedded route Program factory into a failure-checked factory. */
export type FromCurrentHandlerFactory<
  Context extends object,
  Failure,
  ProgramFactory extends (request: Request, context: Context) => AnyProgram
> = ProgramFactory &
  ([ReturnType<ProgramFactory>] extends [
    ReturnType<ProgramFactory> & FailureCheck<Failure, EffectError<ReturnType<ProgramFactory>>>
  ]
    ? unknown
    : (
        request: Request,
        context: Context
      ) => ReturnType<ProgramFactory> &
        FailureCheck<Failure, EffectError<ReturnType<ProgramFactory>>>)

/** A generator body used by `NextEffect.gen`. */
export type GeneratorBody<
  Context extends object,
  Yield extends EffectYield,
  Returned extends AnyResult
> = (
  request: Request,
  context: Context
) => Generator<Yield, Returned, unknown> | AsyncGenerator<Yield, Returned, unknown>

/** Options shared by every Route Handler created by a NextEffect instance. */
export type NextEffectOptions<
  Failure = unknown,
  RequestLayer extends LayerInput = ReturnType<typeof CurrentRequest.layer>,
  Context extends object = NextEffectContext
> = {
  /** Build a request-local Layer once for each native Request. */
  readonly requestLayer?: (request: Request, context: Context) => RequestLayer
  /** Convert a successful value to a native Response. */
  readonly onSuccess?: (
    result: NextEffectSuccess<unknown>,
    request: Request,
    context: Context
  ) => ResponseLike
  /** Convert a typed Program failure to a native Response. */
  readonly onFailure?: (error: Failure, request: Request, context: Context) => ResponseLike
}

/** Runtime options accepted by a managed NextEffect, excluding backend ownership. */
export type NextEffectManagedRuntimeOptions = Omit<RuntimeOptions, 'backend'>

/** Options for `NextEffect.managed`. */
export type NextEffectManagedOptions<
  Failure = unknown,
  RequestLayer extends LayerInput = DefaultRequestLayer,
  Context extends object = NextEffectContext
> = NextEffectOptions<Failure, RequestLayer, Context> & {
  /** Runtime warmup, observers and host-specific context options. */
  readonly runtime?: NextEffectManagedRuntimeOptions
}

/** A detached diagnostic snapshot of a managed NextEffect manager. */
export type NextEffectManagedInspection = {
  readonly state: 'idle' | 'initializing' | 'ready' | 'failed' | 'disposing' | 'disposed'
  readonly runtime?: RuntimeInspection
}

/** A yieldable value returned by fromCurrent route materialization. */
export type NextEffectYieldable<Value, Required extends AnyService = never> = {
  [Symbol.iterator](): Generator<ServiceRequirement<Required>, Value, unknown>
  [Symbol.asyncIterator](): AsyncGenerator<ServiceRequirement<Required>, Value, unknown>
}

/** Options for one typed route success policy. */
type NextEffectRouteSuccessPolicy<A, Context extends object> =
  | {
      /** Handle the success value directly and return a native Response. */
      readonly respond: (value: A, request: Request, context: Context) => ResponseLike
      readonly serialize?: never
      readonly onSuccess?: never
    }
  | {
      readonly respond?: never
      /** Convert the success value to the JSON-safe body wrapped by WebEffect. */
      readonly serialize: (value: A, request: Request, context: Context) => WebJsonValue
      readonly onSuccess?: never
    }
  | {
      readonly respond?: never
      readonly serialize?: never
      /** Replace the shared success policy for this route. */
      readonly onSuccess: (
        result: NextEffectSuccess<A>,
        request: Request,
        context: Context
      ) => ResponseLike
    }
  | {
      /** Use the shared or default success policy for this route. */
      readonly respond?: never
      readonly serialize?: never
      readonly onSuccess?: never
    }

export type NextEffectRouteOptions<
  A,
  Context extends object = NextEffectContext
> = NextEffectRouteSuccessPolicy<A, Context>

/** Service and Failure checks for a managed generator-created route Program. */
export type NextGeneratorChecks<
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Yield extends EffectYield,
  Returned extends AnyResult,
  Failure = unknown
> = NextProgramChecks<Provided, RequestLayer, ProgramFromGenerator<Yield, Returned>, Failure>

/** Failure checks for an embedded generator-created route Program. */
export type FromCurrentGeneratorChecks<
  Yield extends EffectYield,
  Returned extends AnyResult,
  Failure = unknown
> = FailureCheck<Failure, EffectError<ProgramFromGenerator<Yield, Returned>>>
