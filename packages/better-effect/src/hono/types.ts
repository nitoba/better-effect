import type { Result as ResultType } from 'better-result'
import type { Context, Env, HonoRequest, Input, MiddlewareHandler } from 'hono'

import type {
  EffectError,
  EffectYield,
  Program as ProgramType,
  ProgramFromGenerator
} from '../effect/types'
import type { CurrentRequest } from '../standard-services'
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
import type { MissingDependencies } from '../internal/missing-dependencies'

export type AnyResult = ResultType<any, any>
export type AnyProgram = ProgramType<any, any, AnyService>
export type HonoContext = Context<any, any, any>
export type ResponseLike = Response | Promise<Response>
export type AnyHonoMiddleware = MiddlewareHandler<any, any, any>
export type AnyProgramFactory = (context: HonoContext) => AnyProgram
export type AnyRouteOptions = HonoEffectRouteOptions<any, any>

export type MiddlewareInput<Middleware extends AnyHonoMiddleware> =
  Middleware extends MiddlewareHandler<any, any, infer InputType> ? InputType : Input

type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Intersection
) => void
  ? Intersection
  : never

export type MiddlewareInputs<Middlewares extends readonly AnyHonoMiddleware[]> =
  Middlewares extends readonly []
    ? Input
    : Input & UnionToIntersection<MiddlewareInput<Middlewares[number]>>

type ValidatedTarget<InputType extends Input, Target extends 'param' | 'header'> =
  NonNullable<InputType['out']> extends Record<Target, infer Value>
    ? Value extends object
      ? Value
      : never
    : never

type ValidatedRequest<P extends string, InputType extends Input> = Omit<
  HonoRequest<P, NonNullable<InputType['out']>>,
  'param' | 'header'
> & {
  param: [ValidatedTarget<InputType, 'param'>] extends [never]
    ? HonoRequest<P, NonNullable<InputType['out']>>['param']
    : {
        <Key extends keyof ValidatedTarget<InputType, 'param'> & string>(
          key: Key
        ): ValidatedTarget<InputType, 'param'>[Key]
        (key: string): string | undefined
        (): ValidatedTarget<InputType, 'param'>
      }
  header: [ValidatedTarget<InputType, 'header'>] extends [never]
    ? HonoRequest<P, NonNullable<InputType['out']>>['header']
    : {
        <Key extends keyof ValidatedTarget<InputType, 'header'> & string>(
          name: Key
        ): ValidatedTarget<InputType, 'header'>[Key]
        (name: string): string | undefined
        (): ValidatedTarget<InputType, 'header'>
      }
}

export type HonoEffectContext<E extends Env, P extends string, InputType extends Input> = Omit<
  Context<E, P, InputType>,
  'req'
> & {
  readonly req: ValidatedRequest<P, InputType>
}

export type FirstMiddleware<Middlewares extends readonly AnyHonoMiddleware[]> =
  Middlewares extends readonly [infer Head extends AnyHonoMiddleware, ...AnyHonoMiddleware[]]
    ? Head
    : never

export type MiddlewareEnvironment<Middleware extends AnyHonoMiddleware> = [Middleware] extends [
  never
]
  ? Env
  : Middleware extends MiddlewareHandler<infer Environment, any, any>
    ? Environment
    : Env

export type MiddlewarePath<Middleware extends AnyHonoMiddleware> = [Middleware] extends [never]
  ? string
  : Middleware extends MiddlewareHandler<any, infer Path, any>
    ? Path
    : string

export type HonoJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly HonoJsonValue[]
  | { readonly [key: string]: HonoJsonValue }

export type DefaultRequestLayer = ReturnType<typeof CurrentRequest.layer>

export type RequestProvided<RequestLayer extends LayerInput> = ProvidedEnvironment<RequestLayer>

export type AvailableServices<Provided extends AnyService, RequestLayer extends LayerInput> =
  | Provided
  | InstanceType<typeof CurrentRequest>
  | RequestProvided<RequestLayer>

type InvalidFailure<Actual, Expected> = {
  readonly __betterEffectInvalidHonoFailure: {
    readonly actual: Actual
    readonly expected: Expected
  }
}

type FailureCheck<Failure, Actual> = [Actual] extends [Failure]
  ? unknown
  : InvalidFailure<Actual, Failure>

type ProgramFailure<Failure, Program extends AnyProgram> = FailureCheck<
  Failure,
  EffectError<Program>
>

type RequestLayerMissing<
  Provided extends AnyService,
  RequestLayer extends LayerInput
> = MissingServices<
  Extract<RequiredEnvironment<RequestLayer>, AnyService>,
  Extract<Provided | InstanceType<typeof CurrentRequest>, AnyService>
>

type RequestLayerChecks<
  Provided extends AnyService,
  RequestLayer extends LayerInput
> = ValidateLayerInput<RequestLayer> &
  ValidateOneOverride<DefaultRequestLayer, RequestLayer> &
  ([RequestLayerMissing<Provided, RequestLayer>] extends [never]
    ? unknown
    : MissingDependencies<RequestLayerMissing<Provided, RequestLayer>>)

/** Validate a request Layer against the Runtime root and built-in CurrentRequest provider. */
export type HonoRequestLayerChecks<
  Provided extends AnyService,
  RequestLayer extends LayerInput
> = RequestLayerChecks<Provided, RequestLayer>

export type ProgramMissing<
  Provided extends AnyService,
  Program extends AnyProgram
> = ExecutionMissing<Provided, Program>

export type CompleteProgram<
  Provided extends AnyService,
  Program extends AnyProgram,
  Failure = unknown
> = Program &
  ([ProgramMissing<Provided, Program>] extends [never]
    ? unknown
    : MissingDependencies<ProgramMissing<Provided, Program>>) &
  ProgramFailure<Failure, Program>

export type GeneratorBody<
  ContextType extends object,
  Yield extends EffectYield,
  Returned extends AnyResult
> = (
  context: ContextType
) => Generator<Yield, Returned, unknown> | AsyncGenerator<Yield, Returned, unknown>

export type AnyGeneratorBody = GeneratorBody<HonoContext, EffectYield, AnyResult>

export type GeneratorChecks<
  Provided extends AnyService,
  Yield extends EffectYield,
  Returned extends AnyResult,
  Failure = unknown
> = ([ProgramMissing<Provided, ProgramFromGenerator<Yield, Returned>>] extends [never]
  ? unknown
  : MissingDependencies<ProgramMissing<Provided, ProgramFromGenerator<Yield, Returned>>>) &
  FailureCheck<Failure, EffectError<ProgramFromGenerator<Yield, Returned>>>

export type HonoEffectSuccess<A = unknown> = {
  readonly value: A
  readonly status?: number
  readonly serialize?: (value: A) => HonoJsonValue
}

export type HonoEffectOptions<
  Failure = unknown,
  RequestLayer extends LayerInput = DefaultRequestLayer
> = {
  readonly onSuccess?: (result: HonoEffectSuccess<any>, context: HonoContext) => ResponseLike
  readonly onFailure?: (error: Failure, context: HonoContext) => ResponseLike
  readonly requestLayer?: (context: HonoContext) => RequestLayer
}

export type HonoEffectRouteOptions<A, ContextType extends HonoContext = HonoContext> = {
  readonly status?: number
  readonly serialize?: (value: A) => HonoJsonValue
  readonly respond?: (value: A, context: ContextType) => ResponseLike
}
