import { Result } from 'better-result'

import type { Result as ResultType } from 'better-result'

import type { EffectError, EffectRequirements, EffectResult, EffectSuccess } from './types'

type EffectInput<A, E, Requirements> =
  | EffectResult<A, E, Requirements>
  | PromiseLike<EffectResult<A, E, Requirements>>

type AnyEffectInput = EffectInput<any, any, any>
type AnyEffectResult = EffectResult<any, any, any>
type AnyAsyncEffectInput = PromiseLike<AnyEffectResult>

type PreserveAsync<Input, Output> = Input extends PromiseLike<unknown> ? Promise<Output> : Output

type MappedResult<Input, B> = EffectResult<B, EffectError<Input>, EffectRequirements<Input>>

type ErrorMappedResult<Input, E2> = EffectResult<
  EffectSuccess<Input>,
  E2,
  EffectRequirements<Input>
>

type ChainedResult<First, Next> = EffectResult<
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
  <Input>(effect: Input & EffectResult<A, any, any>): ChainedOutput<Input, Next>
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

const mapResult = <A, B, E, Requirements>(
  result: EffectResult<A, E, Requirements>,
  fn: (value: A) => B
): EffectResult<B, E, Requirements> => Result.map(result, fn) as EffectResult<B, E, Requirements>

const mapErrorResult = <A, E1, E2, Requirements>(
  result: EffectResult<A, E1, Requirements>,
  fn: (error: E1) => E2
): EffectResult<A, E2, Requirements> =>
  Result.mapError(result, fn) as EffectResult<A, E2, Requirements>

const andThenResult = <A, B, E1, E2, Requirements1, Requirements2>(
  result: EffectResult<A, E1, Requirements1>,
  next: (value: A) => EffectResult<B, E2, Requirements2>
): EffectResult<B, E1 | E2, Requirements1 | Requirements2> =>
  Result.andThen(result, next as (value: A) => ResultType<B, E2>) as EffectResult<
    B,
    E1 | E2,
    Requirements1 | Requirements2
  >

const andThenAsyncResult = <A, B, E1, E2, Requirements1, Requirements2>(
  result: EffectResult<A, E1, Requirements1>,
  next: (value: A) => PromiseLike<EffectResult<B, E2, Requirements2>>
): Promise<EffectResult<B, E1 | E2, Requirements1 | Requirements2>> =>
  Result.andThenAsync(
    result,
    (value) => Promise.resolve(next(value)) as Promise<ResultType<B, E2>>
  ) as Promise<EffectResult<B, E1 | E2, Requirements1 | Requirements2>>

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
      mapResult(result as EffectResult<unknown, unknown, never>, fn)
    )
  }

  return mapResult(first as EffectResult<unknown, unknown, never>, fn)
}

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
      mapErrorResult(result as EffectResult<unknown, unknown, never>, fn)
    )
  }

  return mapErrorResult(first as EffectResult<unknown, unknown, never>, fn)
}

export function andThen<A, Next extends AnyEffectResult>(
  next: (value: A) => Next
): AndThenOperation<A, Next>
export function andThen<Input, Next extends AnyEffectResult>(
  effect: Input & AnyEffectResult,
  next: (value: EffectSuccess<Input>) => Next
): ChainedOutput<Input, Next>
export function andThen(first: unknown, second?: unknown): unknown {
  if (typeof first === 'function' && second === undefined) {
    return (effect: unknown) => andThen(effect as never, first as never)
  }

  const next = second as (value: unknown) => EffectResult<unknown, unknown, never>

  return andThenResult(first as EffectResult<unknown, unknown, never>, next)
}

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

  const next = second as (value: unknown) => PromiseLike<EffectResult<unknown, unknown, never>>

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) =>
      andThenAsyncResult(result as EffectResult<unknown, unknown, never>, next)
    )
  }

  return andThenAsyncResult(first as EffectResult<unknown, unknown, never>, next)
}
