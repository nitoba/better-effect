import type { Err, InferErr, InferOk, Result as ResultType } from 'better-result'

import type { AnyService } from '../service/types'

type ResultValue = ResultType<any, any>

/** Keep nested Effect errors and Service requirements in one inferred yield. */
type EffectIterator<A, E, R extends AnyService> = {
  [Symbol.iterator](): Generator<Err<never, E> & ServiceRequirement<R>, A, unknown>
}

type EffectMethods<A, E, R extends AnyService> = {
  map<B>(fn: (value: A) => B): Effect<B, E, R>
  mapError<E2>(fn: (error: E) => E2): Effect<A, E2, R>

  tryRecover<Next extends ResultValue>(
    fn: (error: E) => Next
  ): Effect<A | EffectSuccess<Next>, EffectError<Next>, R | EffectRequirements<Next>>

  tryRecoverAsync<Next extends ResultValue>(
    fn: (error: E) => Promise<Next>
  ): Promise<Effect<A | EffectSuccess<Next>, EffectError<Next>, R | EffectRequirements<Next>>>

  andThen<Next extends ResultValue>(
    fn: (value: A) => Next
  ): Effect<EffectSuccess<Next>, E | EffectError<Next>, R | EffectRequirements<Next>>

  andThenAsync<Next extends ResultValue>(
    fn: (value: A) => Promise<Next>
  ): Promise<Effect<EffectSuccess<Next>, E | EffectError<Next>, R | EffectRequirements<Next>>>

  tap(fn: (value: A) => void): Effect<A, E, R>
  tapAsync(fn: (value: A) => PromiseLike<void>): Promise<Effect<A, E, R>>
  tapError(fn: (error: E) => void): Effect<A, E, R>
  tapErrorAsync(fn: (error: E) => PromiseLike<void>): Promise<Effect<A, E, R>>
  tapBoth(handlers: { ok: (value: A) => void; err: (error: E) => void }): Effect<A, E, R>
  tapBothAsync(handlers: {
    ok: (value: A) => PromiseLike<void>
    err: (error: E) => PromiseLike<void>
  }): Promise<Effect<A, E, R>>
}

/**
 * Type-only identity for a Service requirement yielded by a generator.
 *
 * The declaration has no runtime value. Service iterators return their
 * resolved instances without yielding a marker at runtime.
 */
export declare const ServiceRequirementTypeId: unique symbol

/** Type-only identity for requirement metadata attached to Effect results. */
export declare const EffectRequirementsTypeId: unique symbol

/** Type-only identity for lazy Effect programs. */
export declare const ProgramTypeId: unique symbol

/** Required declaration-only variance carrier for Effect Service requirements. */
export interface EffectVariance<out R extends AnyService> {
  readonly requirements: R
}

/** Required declaration-only variance carrier for a lazy Program. */
export interface ProgramVariance<out A, out E, out R extends AnyService> {
  readonly success: A
  readonly error: E
  readonly requirements: R
}

/**
 * Metadata carried by the yield type of a Service token.
 *
 * This interface is intentionally phantom: it is used only while TypeScript
 * infers a generator's yielded values.
 */
export interface ServiceRequirement<out T> {
  readonly [ServiceRequirementTypeId]: T
}

/** A `better-result` Result with required declaration-only metadata for Services. */
export type Effect<A, E, R extends AnyService = never> = EffectMethods<A, E, R> &
  ResultType<A, E> &
  EffectIterator<A, E, R> & {
    readonly [EffectRequirementsTypeId]: EffectVariance<R>
  }

/** A nominal lazy computation that produces an Effect when invoked. */
export type Program<A, E, R extends AnyService = never> = {
  (): Effect<A, E, R> | Promise<Effect<A, E, R>>
  readonly [ProgramTypeId]: ProgramVariance<A, E, R>
}

/** An Effect with erased success, error, and Service requirements. */
export type AnyEffect = Effect<unknown, unknown, AnyService>

/** Values that an Effect generator may yield. */
export type EffectYield = Err<never, unknown> | ServiceRequirement<unknown>

/** Extract the error channel from Result values yielded by a generator. */
export type InferYieldError<Y> = Y extends Err<never, infer E> ? E : never

/** Extract branded Service instances carried by yielded Service requirements. */
export type InferYieldRequirements<Y> =
  Y extends ServiceRequirement<infer Requirement>
    ? Requirement extends AnyService
      ? Requirement
      : never
    : never

type InferEffectRequirements<T> = T extends unknown
  ? typeof EffectRequirementsTypeId extends keyof T
    ? T extends {
        readonly [EffectRequirementsTypeId]: EffectVariance<infer Requirements extends AnyService>
      }
      ? Requirements
      : never
    : never
  : never

type InferProgramSuccess<T> = T extends {
  readonly [ProgramTypeId]: ProgramVariance<infer Success, any, any>
}
  ? Success
  : never

type InferProgramError<T> = T extends {
  readonly [ProgramTypeId]: ProgramVariance<any, infer Error, any>
}
  ? Error
  : never

type InferProgramRequirements<T> = T extends {
  readonly [ProgramTypeId]: ProgramVariance<any, any, infer Requirements>
}
  ? Requirements
  : never

/** Extract declaration-only Service requirements from an Effect or Promise. */
export type EffectRequirements<T> = T extends unknown
  ? InferProgramRequirements<T> extends never
    ? InferEffectRequirements<Awaited<T>>
    : InferProgramRequirements<T>
  : never

/** Extract the success value from an Effect or Promise. */
export type EffectSuccess<T> = T extends unknown
  ? InferProgramSuccess<T> extends never
    ? Awaited<T> extends ResultType<infer A, unknown>
      ? A
      : never
    : InferProgramSuccess<T>
  : never

/** Extract the error value from an Effect or Promise. */
export type EffectError<T> = T extends unknown
  ? InferProgramError<T> extends never
    ? Awaited<T> extends ResultType<unknown, infer E>
      ? E
      : never
    : InferProgramError<T>
  : never

/** Build the public Effect type produced from a generator. */
export type EffectFromGenerator<Yield, Returned extends ResultType<any, any>> = Effect<
  InferOk<Returned>,
  InferYieldError<Yield> | InferErr<Returned>,
  InferYieldRequirements<Yield> | EffectRequirements<Returned>
>

/** Build the nominal lazy Program produced from a generator. */
export type ProgramFromGenerator<Yield, Returned extends ResultType<any, any>> = Program<
  InferOk<Returned>,
  InferYieldError<Yield> | InferErr<Returned>,
  InferYieldRequirements<Yield> | EffectRequirements<Returned>
>
