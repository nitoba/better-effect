import { Result } from 'better-result'

import type { Result as ResultType } from 'better-result'

import type { AnyService } from '../service'
import type { Effect, EffectError, EffectRequirements, EffectSuccess } from './types'

type EffectInput<A, E, Requirements extends AnyService> =
  | Effect<A, E, Requirements>
  | PromiseLike<Effect<A, E, Requirements>>

type AnyEffectInput = EffectInput<any, any, any>
type AnyEffectValue = Effect<any, any, any>
type AnyAsyncEffectInput = PromiseLike<AnyEffectValue>

type PreserveAsync<Input, Output> = Input extends PromiseLike<unknown> ? Promise<Output> : Output

type MappedResult<Input, B> = Effect<B, EffectError<Input>, EffectRequirements<Input>>

type ErrorMappedResult<Input, E2> = Effect<EffectSuccess<Input>, E2, EffectRequirements<Input>>

type ChainedResult<First, Next> = Effect<
  EffectSuccess<Next>,
  EffectError<First> | EffectError<Next>,
  EffectRequirements<First> | EffectRequirements<Next>
>

type ChainedOutput<First, Next> = ChainedResult<First, Next>

type AsyncChainedOutput<First, Next> = Promise<ChainedResult<First, Next>>

type MapOperation<A, B> = {
  <Input>(effect: Input & EffectInput<A, any, any>): PreserveAsync<Input, MappedResult<Input, B>>
}

type MapErrorOperation<E1, E2> = {
  <Input>(
    effect: Input & EffectInput<any, E1, any>
  ): PreserveAsync<Input, ErrorMappedResult<Input, E2>>
}

type AndThenOperation<A, Next> = {
  <Input>(effect: Input & Effect<A, any, any>): ChainedOutput<Input, Next>
}

type AndThenAsyncOperation<A, Next> = {
  <Input>(effect: Input & EffectInput<A, any, any>): AsyncChainedOutput<Input, Next>
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false
  }

  return 'then' in value && typeof value.then === 'function'
}

const mapResult = <A, B, E, Requirements extends AnyService>(
  result: Effect<A, E, Requirements>,
  fn: (value: A) => B
): Effect<B, E, Requirements> => Result.map(result, fn) as Effect<B, E, Requirements>

const mapErrorResult = <A, E1, E2, Requirements extends AnyService>(
  result: Effect<A, E1, Requirements>,
  fn: (error: E1) => E2
): Effect<A, E2, Requirements> => Result.mapError(result, fn) as Effect<A, E2, Requirements>

const andThenResult = <
  A,
  B,
  E1,
  E2,
  Requirements1 extends AnyService,
  Requirements2 extends AnyService
>(
  result: Effect<A, E1, Requirements1>,
  next: (value: A) => Effect<B, E2, Requirements2>
): Effect<B, E1 | E2, Requirements1 | Requirements2> =>
  Result.andThen(result, next as (value: A) => ResultType<B, E2>) as Effect<
    B,
    E1 | E2,
    Requirements1 | Requirements2
  >

const andThenAsyncResult = <
  A,
  B,
  E1,
  E2,
  Requirements1 extends AnyService,
  Requirements2 extends AnyService
>(
  result: Effect<A, E1, Requirements1>,
  next: (value: A) => PromiseLike<Effect<B, E2, Requirements2>>
): Promise<Effect<B, E1 | E2, Requirements1 | Requirements2>> =>
  Result.andThenAsync(
    result,
    (value) => Promise.resolve(next(value)) as Promise<ResultType<B, E2>>
  ) as Promise<Effect<B, E1 | E2, Requirements1 | Requirements2>>

/**
 * Map the successful value of a Result or Effect result.
 *
 * Supports both data-first and data-last forms and preserves asynchronous
 * results and phantom Service requirements.
 *
 * @example
 * ```ts
 * const doubled = Effect.map(Result.ok(2), (value) => value * 2)
 * const toLabel = Effect.map((value: number) => `#${value}`)
 * ```
 */
export function map<A, B>(fn: (value: A) => B): MapOperation<A, B>
export function map<Input, B>(
  effect: Input & AnyEffectInput,
  fn: (value: EffectSuccess<Input>) => B
): PreserveAsync<Input, MappedResult<Input, B>>
export function map(first: unknown, second?: unknown): unknown {
  if (typeof first === 'function' && second === undefined) {
    return (effect: unknown) => map(effect as never, first as never)
  }

  const fn = second as (value: unknown) => unknown

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) =>
      mapResult(result as Effect<unknown, unknown, never>, fn)
    )
  }

  return mapResult(first as Effect<unknown, unknown, never>, fn)
}

/**
 * Map the error value of a Result or Effect result while preserving its
 * successful value, asynchronous shape, and Service requirements.
 *
 * @example
 * ```ts
 * const labelled = Effect.mapError(Result.err('missing'), (error) => ({ error }))
 * ```
 */
export function mapError<E1, E2>(fn: (error: E1) => E2): MapErrorOperation<E1, E2>
export function mapError<Input, E2>(
  effect: Input & AnyEffectInput,
  fn: (error: EffectError<Input>) => E2
): PreserveAsync<Input, ErrorMappedResult<Input, E2>>
export function mapError(first: unknown, second?: unknown): unknown {
  if (typeof first === 'function' && second === undefined) {
    return (effect: unknown) => mapError(effect as never, first as never)
  }

  const fn = second as (error: unknown) => unknown

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) =>
      mapErrorResult(result as Effect<unknown, unknown, never>, fn)
    )
  }

  return mapErrorResult(first as Effect<unknown, unknown, never>, fn)
}

/**
 * Chain a synchronous Result-producing operation after a successful result.
 *
 * The next operation is skipped when the input is an error. Both error types
 * and both sets of Service requirements are preserved in the output.
 *
 * @example
 * ```ts
 * const user = Effect.andThen(Result.ok('u1'), (id) => repository.find(id))
 * ```
 */
export function andThen<A, Next extends AnyEffectValue>(
  next: (value: A) => Next
): AndThenOperation<A, Next>
export function andThen<Input, Next extends AnyEffectValue>(
  effect: Input & AnyEffectValue,
  next: (value: EffectSuccess<Input>) => Next
): ChainedOutput<Input, Next>
export function andThen(first: unknown, second?: unknown): unknown {
  if (typeof first === 'function' && second === undefined) {
    return (effect: unknown) => andThen(effect as never, first as never)
  }

  const next = second as (value: unknown) => Effect<unknown, unknown, never>

  return andThenResult(first as Effect<unknown, unknown, never>, next)
}

/**
 * Chain an asynchronous Result-producing operation after a successful result.
 *
 * The returned value is always a Promise and retains both operations' error
 * and Service-requirement metadata.
 *
 * @example
 * ```ts
 * const user = Effect.andThenAsync(loadUser(), (user) => fetchProfile(user.id))
 * ```
 */
export function andThenAsync<A, Next extends AnyAsyncEffectInput>(
  next: (value: A) => Next
): AndThenAsyncOperation<A, Next>
export function andThenAsync<Input, Next extends AnyAsyncEffectInput>(
  effect: Input & AnyEffectInput,
  next: (value: EffectSuccess<Input>) => Next
): AsyncChainedOutput<Input, Next>
export function andThenAsync(first: unknown, second?: unknown): unknown {
  if (typeof first === 'function' && second === undefined) {
    return (effect: unknown) => andThenAsync(effect as never, first as never)
  }

  const next = second as (value: unknown) => PromiseLike<Effect<unknown, unknown, never>>

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) =>
      andThenAsyncResult(result as Effect<unknown, unknown, never>, next)
    )
  }

  return andThenAsyncResult(first as Effect<unknown, unknown, never>, next)
}
