import type { Result as ResultType } from 'better-result'
import type { Context, Env, HonoRequest, Input, MiddlewareHandler } from 'hono'

import type {
  EffectError,
  EffectRequirements,
  EffectYield,
  Program as ProgramType,
  ProgramFromGenerator,
  ServiceRequirement
} from '../effect/types'
import type { CurrentRequest } from '../standard-services/current-request'
import type {
  LayerInput,
  MissingServices,
  ProvidedEnvironment,
  RequiredEnvironment,
  ValidateLayerInput,
  ValidateOneOverride
} from '../layer/inference'
import type { AnyService } from '../service'

export type AnyResult = ResultType<any, any>
export type AnyProgram = ProgramType<any, any, AnyService>
export type HonoContext = Context<any, any, any>
export type ResponseLike = Response | Promise<Response>
export type AnyHonoMiddleware = MiddlewareHandler<any, any, any>
export type AnyProgramFactory = (context: HonoContext) => AnyProgram
export type AnyRouteOptions = HonoEffectRouteOptions<any, any>

/** A builder operation resolved while the application Layer is acquired. */
export interface HonoEffectOperation<A, Requirements extends AnyService = never> {
  readonly [Symbol.iterator]: () => Generator<ServiceRequirement<Requirements>, A, unknown>
  readonly [Symbol.asyncIterator]: () => AsyncGenerator<
    ServiceRequirement<Requirements>,
    A,
    unknown
  >
}

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

type IsAny<Type> = 0 extends 1 & Type ? true : false

type Specific<Type> = IsAny<Type> extends true ? never : Type

type MiddlewareEnvironmentOf<Middleware extends AnyHonoMiddleware> =
  Middleware extends MiddlewareHandler<infer Environment, any, any> ? Environment : never

type MiddlewarePathOf<Middleware extends AnyHonoMiddleware> =
  Middleware extends MiddlewareHandler<any, infer Path, any> ? Path : never

type MiddlewareEnvironmentCandidates<Middlewares extends readonly AnyHonoMiddleware[]> =
  Middlewares extends readonly [
    infer Head extends AnyHonoMiddleware,
    ...infer Tail extends readonly AnyHonoMiddleware[]
  ]
    ? Specific<MiddlewareEnvironmentOf<Head>> | MiddlewareEnvironmentCandidates<Tail>
    : Specific<MiddlewareEnvironmentOf<Middlewares[number]>>

type MiddlewarePathCandidates<Middlewares extends readonly AnyHonoMiddleware[]> =
  Middlewares extends readonly [
    infer Head extends AnyHonoMiddleware,
    ...infer Tail extends readonly AnyHonoMiddleware[]
  ]
    ? Specific<MiddlewarePathOf<Head>> extends infer Path
      ? Path extends string
        ? string extends Path
          ? MiddlewarePathCandidates<Tail>
          : Path | MiddlewarePathCandidates<Tail>
        : MiddlewarePathCandidates<Tail>
      : never
    : Specific<MiddlewarePathOf<Middlewares[number]>> extends infer Path
      ? Path extends string
        ? string extends Path
          ? never
          : Path
        : never
      : never

export type MiddlewareEnvironment<Middlewares extends readonly AnyHonoMiddleware[]> = [
  MiddlewareEnvironmentCandidates<Middlewares>
] extends [never]
  ? Env
  : Extract<UnionToIntersection<MiddlewareEnvironmentCandidates<Middlewares>>, Env>

export type MiddlewarePath<Middlewares extends readonly AnyHonoMiddleware[]> = [
  MiddlewarePathCandidates<Middlewares>
] extends [never]
  ? string
  : MiddlewarePathCandidates<Middlewares>

export type HonoJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly HonoJsonValue[]
  | { readonly [key: string]: HonoJsonValue }

export type DefaultRequestLayer = ReturnType<typeof CurrentRequest.layer>

export type RequestProvided<RequestLayer extends LayerInput> = ProvidedEnvironment<RequestLayer>

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

/** Validate a request Layer against the built-in CurrentRequest provider. */
export type HonoRequestLayerChecks<RequestLayer extends LayerInput> =
  ValidateLayerInput<RequestLayer> & ValidateOneOverride<DefaultRequestLayer, RequestLayer>

/** Requirements of a route Program that must be provided by the application Layer. */
export type HonoProgramRequirements<
  RequestLayer extends LayerInput,
  Program extends AnyProgram
> = Extract<
  | RequiredEnvironment<RequestLayer>
  | MissingServices<
      Extract<EffectRequirements<Program>, AnyService>,
      Extract<InstanceType<typeof CurrentRequest> | RequestProvided<RequestLayer>, AnyService>
    >,
  AnyService
>

/** Validate only a route Program's typed failure channel at the builder boundary. */
export type CompleteProgram<Program extends AnyProgram, Failure = unknown> = Program &
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
  Yield extends EffectYield,
  Returned extends AnyResult,
  Failure = unknown
> = FailureCheck<Failure, EffectError<ProgramFromGenerator<Yield, Returned>>>

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
