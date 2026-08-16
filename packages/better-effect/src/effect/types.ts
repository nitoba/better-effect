import type { Err, InferErr, InferOk, Result as ResultType } from 'better-result'

import type { AnyServiceToken } from '../service/types'

/**
 * Type-only identity for a Service requirement yielded by a generator.
 *
 * The declaration has no runtime value. Service iterators return their
 * resolved instances without yielding a marker at runtime.
 */
export declare const ServiceRequirementTypeId: unique symbol

/** Type-only identity for requirement metadata attached to Effect results. */
export declare const EffectRequirementsTypeId: unique symbol

/**
 * Metadata carried by the yield type of a Service token.
 *
 * This interface is intentionally phantom: it is used only while TypeScript
 * infers a generator's yielded values.
 */
export interface ServiceRequirement<out T extends AnyServiceToken> {
  readonly [ServiceRequirementTypeId]: T
}

/**
 * A `better-result` Result with phantom metadata for required Services.
 *
 * @typeParam A The successful value.
 * @typeParam E The error value.
 * @typeParam Requirements The tagged Service contracts required to produce it.
 */
export type EffectResult<A, E, Requirements = never> = ResultType<A, E> & {
  readonly [EffectRequirementsTypeId]?: Requirements
}

/** An Effect result with unknown success, error, and Service requirements. */
export type AnyEffectResult = EffectResult<unknown, unknown, any>

/** Values that an Effect generator may yield. */
export type EffectYield = Err<never, unknown> | ServiceRequirement<AnyServiceToken>

/** Extract the error channel from Result values yielded by a generator. */
export type InferYieldError<Y> = Y extends Err<never, infer E> ? E : never

/** Extract Service tokens carried by yielded Service requirements. */
export type InferYieldRequirements<Y> =
  Y extends ServiceRequirement<infer Requirement> ? Requirement : never

type InferEffectRequirements<T> = T extends unknown
  ? typeof EffectRequirementsTypeId extends keyof T
    ? T extends {
        readonly [EffectRequirementsTypeId]?: infer Requirements
      }
      ? Requirements
      : never
    : never
  : never

/** Extract phantom Service requirements from an Effect result or Promise. */
export type EffectRequirements<T> = InferEffectRequirements<Awaited<T>>

/** Extract the success value from an Effect result or Promise. */
export type EffectSuccess<T> = Awaited<T> extends ResultType<infer A, unknown> ? A : never

/** Extract the error value from an Effect result or Promise. */
export type EffectError<T> = Awaited<T> extends ResultType<unknown, infer E> ? E : never

/** Build the public result type produced from an Effect generator. */
export type EffectFromGenerator<Yield, Returned extends ResultType<any, any>> = EffectResult<
  InferOk<Returned>,
  InferYieldError<Yield> | InferErr<Returned>,
  InferYieldRequirements<Yield> | EffectRequirements<Returned>
>
