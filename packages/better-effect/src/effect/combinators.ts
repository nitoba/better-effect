import {
  matchError as resultMatchError,
  matchErrorPartial as resultMatchErrorPartial,
  Result
} from 'better-result'

import type { Result as ResultType } from 'better-result'

import type { AnyService } from '../service'
import { isPromiseLike } from '../utils/runtime'
import type { Effect, EffectError, EffectRequirements, EffectSuccess } from './types'

type EffectInput<A, E> = ResultType<A, E> | PromiseLike<ResultType<A, E>>

type AnyEffectInput = EffectInput<any, any>
type AnyEffectValue = ResultType<any, any>
type AnyAsyncEffectInput = PromiseLike<ResultType<any, any>>
type CombinatorCallback = (value: any) => any
type CombinatorInput = AnyEffectInput | CombinatorCallback

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
  <Input>(effect: Input & EffectInput<A, any>): PreserveAsync<Input, MappedResult<Input, B>>
}

type MapErrorOperation<E1, E2> = {
  <Input>(effect: Input & EffectInput<any, E1>): PreserveAsync<Input, ErrorMappedResult<Input, E2>>
}

type AndThenOperation<Next> = {
  <Input>(effect: Input & AnyEffectValue): ChainedOutput<Input, Next>
}

type AndThenAsyncOperation<A, Next> = {
  <Input>(effect: Input & EffectInput<A, any>): AsyncChainedOutput<Input, Next>
}

type TappedResult<Input> = Effect<
  EffectSuccess<Input>,
  EffectError<Input>,
  EffectRequirements<Input>
>

type RecoveredResult<Input, Next> = Effect<
  EffectSuccess<Input> | EffectSuccess<Next>,
  EffectError<Next>,
  EffectRequirements<Input> | EffectRequirements<Next>
>

type FlattenedResult<Input> = Effect<
  EffectSuccess<EffectSuccess<Input>>,
  EffectError<Input> | EffectError<EffectSuccess<Input>>,
  EffectRequirements<Input> | EffectRequirements<EffectSuccess<Input>>
>

type AsResult<Input, Value> = Effect<Value, EffectError<Input>, EffectRequirements<Input>>

type MatchedResult<Input, OkResult, ErrResult> = Effect<
  EffectSuccess<OkResult> | EffectSuccess<ErrResult>,
  EffectError<OkResult> | EffectError<ErrResult>,
  EffectRequirements<Input> | EffectRequirements<OkResult> | EffectRequirements<ErrResult>
>

type AllResult<Results extends readonly AnyEffectValue[]> = Effect<
  { -readonly [Index in keyof Results]: EffectSuccess<Results[Index]> },
  EffectError<Results[number]>,
  EffectRequirements<Results[number]>
>

type ZipResult<Left, Right> = Effect<
  [EffectSuccess<Left>, EffectSuccess<Right>],
  EffectError<Left> | EffectError<Right>,
  EffectRequirements<Left> | EffectRequirements<Right>
>

type TapOperation = {
  <Input>(
    effect: Input & AnyEffectInput,
    fn: (value: EffectSuccess<Input>) => void
  ): PreserveAsync<Input, TappedResult<Input>>
}

type TapErrorOperation = {
  <Input>(
    effect: Input & AnyEffectInput,
    fn: (error: EffectError<Input>) => void
  ): PreserveAsync<Input, TappedResult<Input>>
}

type TapBothOperation = {
  <Input>(
    effect: Input & AnyEffectInput,
    handlers: {
      ok: (value: EffectSuccess<Input>) => void
      err: (error: EffectError<Input>) => void
    }
  ): PreserveAsync<Input, TappedResult<Input>>
}

type TapAsyncOperation = {
  <Input>(effect: Input & AnyEffectInput): Promise<TappedResult<Input>>
}

type TapErrorAsyncOperation = {
  <Input>(effect: Input & AnyEffectInput): Promise<TappedResult<Input>>
}

type TapBothAsyncOperation = {
  <Input>(effect: Input & AnyEffectInput): Promise<TappedResult<Input>>
}

type TaggedErrorLike = Error & { readonly _tag: string }

type TaggedErrorHandlers<ErrorValue extends TaggedErrorLike> = {
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- better-result matchers allow arbitrary handler results.
  [Tag in ErrorValue['_tag']]: (error: Extract<ErrorValue, { readonly _tag: Tag }>) => unknown
}

type TaggedErrorOf<Input> = Extract<EffectError<Input>, TaggedErrorLike>

type TaggedErrorHandlersFor<Input> = [EffectError<Input>] extends [TaggedErrorLike]
  ? TaggedErrorHandlers<TaggedErrorOf<Input>>
  : never

type HandlerReturn<Handlers> = {
  [Key in keyof Handlers]: Handlers[Key] extends (error: never) => infer Return ? Return : never
}[keyof Handlers]

type UnhandledTaggedErrors<ErrorValue extends TaggedErrorLike, Handlers> = Exclude<
  ErrorValue,
  { readonly _tag: Extract<keyof Handlers, ErrorValue['_tag']> }
>

type MatchErrorResult<Input, Handlers> = Effect<
  EffectSuccess<Input>,
  HandlerReturn<Handlers>,
  EffectRequirements<Input>
>

type MatchErrorPartialResult<Input, Handlers> = Effect<
  EffectSuccess<Input>,
  HandlerReturn<Handlers> | UnhandledTaggedErrors<TaggedErrorOf<Input>, Handlers>,
  EffectRequirements<Input>
>

type RecoverOperation<Next> = {
  <Input>(
    effect: Input & AnyEffectInput,
    fn: (error: EffectError<Input>) => Next
  ): PreserveAsync<Input, RecoveredResult<Input, Next>>
}

type RecoverAsyncOperation<Next> = {
  <Input>(
    effect: Input & AnyEffectInput,
    fn: (error: EffectError<Input>) => Next
  ): Promise<RecoveredResult<Input, Next>>
}

const asResult = <Value>(value: Value): ResultType<any, any> => {
  // SAFETY: Effect is the declaration-only Result facade, so every runtime value is a Result.
  return value as ResultType<any, any>
}

const mapResult = <A, B, E, Requirements extends AnyService>(
  result: ResultType<A, E>,
  fn: (value: A) => B
): Effect<B, E, Requirements> => {
  // SAFETY: Result.map changes only the success channel; the declaration-only Effect marker is restored by this adapter.
  return Result.map(result, fn) as Effect<B, E, Requirements>
}

const mapErrorResult = <A, E1, E2, Requirements extends AnyService>(
  result: ResultType<A, E1>,
  fn: (error: E1) => E2
): Effect<A, E2, Requirements> => {
  // SAFETY: Result.mapError changes only the error channel; the declaration-only Effect marker is restored by this adapter.
  return Result.mapError(result, fn) as Effect<A, E2, Requirements>
}

const andThenResult = <
  A,
  B,
  E1,
  E2,
  Requirements1 extends AnyService,
  Requirements2 extends AnyService
>(
  result: ResultType<A, E1>,
  next: (value: A) => ResultType<B, E2>
): Effect<B, E1 | E2, Requirements1 | Requirements2> => {
  // SAFETY: The public callback returns an Effect, whose only runtime contract is the underlying Result.
  const resultNext = next as (value: A) => ResultType<B, E2>

  // SAFETY: Result.andThen unions Result errors; the declaration-only Effect marker is restored by this adapter.
  return Result.andThen(result, resultNext) as Effect<B, E1 | E2, Requirements1 | Requirements2>
}

const andThenAsyncResult = <
  A,
  B,
  E1,
  E2,
  Requirements1 extends AnyService,
  Requirements2 extends AnyService
>(
  result: ResultType<A, E1>,
  next: (value: A) => PromiseLike<ResultType<B, E2>>
): Promise<Effect<B, E1 | E2, Requirements1 | Requirements2>> => {
  // SAFETY: The public callback returns an Effect, whose only runtime contract is the underlying Result.
  const resultNext = (value: A) => {
    // SAFETY: Promise resolution preserves the callback's Result value; only declaration-only Effect metadata is erased.
    return Promise.resolve(next(value)) as Promise<ResultType<B, E2>>
  }

  // SAFETY: Result.andThenAsync unions Result errors; the declaration-only Effect marker is restored by this adapter.
  return Result.andThenAsync(result, resultNext) as Promise<
    Effect<B, E1 | E2, Requirements1 | Requirements2>
  >
}

/**
 * Map the successful value of a Result or Effect result.
 *
 * Supports both data-first and data-last forms and preserves asynchronous
 * results and declaration-only Service requirements.
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
export function map(first: CombinatorInput, second?: CombinatorCallback): any {
  if (first instanceof Function && second === undefined) {
    // SAFETY: The curried overload accepts a unary mapping callback in this branch.
    const callback = first as CombinatorCallback

    return (effect: AnyEffectInput) => {
      // SAFETY: The overload implementation has already established the callback and Effect input positions.
      return map(effect as never, callback as never)
    }
  }

  // SAFETY: The data-first overload requires the second argument to be a unary mapping callback.
  const fn = second as CombinatorCallback

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) => {
      // SAFETY: Result is the runtime representation shared by Effect and better-result.
      return mapResult(result as ResultType<any, any>, fn)
    })
  }

  // SAFETY: The data-first overload supplies a Result-compatible Effect value.
  return mapResult(first as ResultType<any, any>, fn)
}

/**
 * Map the error value of a Result or Effect result while preserving its
 * successful value, asynchronous shape, and declaration-only Service requirements.
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
export function mapError(first: CombinatorInput, second?: CombinatorCallback): any {
  if (first instanceof Function && second === undefined) {
    // SAFETY: The curried overload accepts a unary error-mapping callback in this branch.
    const callback = first as CombinatorCallback

    return (effect: AnyEffectInput) => {
      // SAFETY: The overload implementation has already established the callback and Effect input positions.
      return mapError(effect as never, callback as never)
    }
  }

  // SAFETY: The data-first overload requires the second argument to be a unary error-mapping callback.
  const fn = second as CombinatorCallback

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) => {
      // SAFETY: Result is the runtime representation shared by Effect and better-result.
      return mapErrorResult(result as ResultType<any, any>, fn)
    })
  }

  // SAFETY: The data-first overload supplies a Result-compatible Effect value.
  return mapErrorResult(first as ResultType<any, any>, fn)
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
): AndThenOperation<Next>
export function andThen<Input, Next extends AnyEffectValue>(
  effect: Input & AnyEffectValue,
  next: (value: EffectSuccess<Input>) => Next
): ChainedOutput<Input, Next>
export function andThen(first: CombinatorInput, second?: CombinatorCallback): any {
  if (first instanceof Function && second === undefined) {
    // SAFETY: The curried overload accepts a unary continuation in this branch.
    const callback = first as CombinatorCallback

    return (effect: AnyEffectInput) => {
      // SAFETY: The overload implementation has already established the callback and Effect input positions.
      return andThen(effect as never, callback as never)
    }
  }

  // SAFETY: The data-first overload requires the second argument to return a Result.
  const next = second as CombinatorCallback

  // SAFETY: The data-first overload supplies a Result-compatible Effect value.
  return andThenResult(first as ResultType<any, any>, next)
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
export function andThenAsync(first: CombinatorInput, second?: CombinatorCallback): any {
  if (first instanceof Function && second === undefined) {
    // SAFETY: The curried overload accepts a unary asynchronous continuation in this branch.
    const callback = first as CombinatorCallback

    return (effect: AnyEffectInput) => {
      // SAFETY: The overload implementation has already established the callback and Effect input positions.
      return andThenAsync(effect as never, callback as never)
    }
  }

  // SAFETY: The data-first overload requires the second argument to return a PromiseLike Effect.
  const next = second as CombinatorCallback

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) => {
      // SAFETY: Result is the runtime representation shared by Effect and better-result.
      return andThenAsyncResult(result as ResultType<any, any>, next)
    })
  }

  // SAFETY: The data-first overload supplies a Result-compatible Effect value.
  return andThenAsyncResult(first as ResultType<any, any>, next)
}

const tapResult = <A, E, Requirements extends AnyService>(
  result: ResultType<A, E>,
  fn: (value: A) => void
): Effect<A, E, Requirements> =>
  // SAFETY: Result.tap preserves the Result value; the declaration-only Effect marker is restored here.
  Result.tap(result, fn) as Effect<A, E, Requirements>

const tapErrorResult = <A, E, Requirements extends AnyService>(
  result: ResultType<A, E>,
  fn: (error: E) => void
): Effect<A, E, Requirements> =>
  // SAFETY: Result.tapError preserves the Result value; the declaration-only Effect marker is restored here.
  Result.tapError(result, fn) as Effect<A, E, Requirements>

const tapBothResult = <A, E, Requirements extends AnyService>(
  result: ResultType<A, E>,
  handlers: { ok: (value: A) => void; err: (error: E) => void }
): Effect<A, E, Requirements> =>
  // SAFETY: Result.tapBoth preserves the Result value; the declaration-only Effect marker is restored here.
  Result.tapBoth(result, handlers) as Effect<A, E, Requirements>

const tapAsyncResult = <A, E, Requirements extends AnyService>(
  result: ResultType<A, E>,
  fn: (value: A) => PromiseLike<void>
): Promise<Effect<A, E, Requirements>> =>
  // SAFETY: Result.tapAsync preserves the Result value and owns observer defect behavior; only the Effect marker is restored here.
  Result.tapAsync(result, (value) => Promise.resolve(fn(value))) as Promise<
    Effect<A, E, Requirements>
  >

const tapErrorAsyncResult = <A, E, Requirements extends AnyService>(
  result: ResultType<A, E>,
  fn: (error: E) => PromiseLike<void>
): Promise<Effect<A, E, Requirements>> =>
  // SAFETY: Result.tapErrorAsync preserves the Result value and owns observer defect behavior; only the Effect marker is restored here.
  Result.tapErrorAsync(result, (error) => Promise.resolve(fn(error))) as Promise<
    Effect<A, E, Requirements>
  >

const tapBothAsyncResult = <A, E, Requirements extends AnyService>(
  result: ResultType<A, E>,
  handlers: { ok: (value: A) => PromiseLike<void>; err: (error: E) => PromiseLike<void> }
): Promise<Effect<A, E, Requirements>> =>
  // SAFETY: Result.tapBothAsync selects one branch and preserves the Result; only the Effect marker is restored here.
  Result.tapBothAsync(result, {
    ok: (value) => Promise.resolve(handlers.ok(value)),
    err: (error) => Promise.resolve(handlers.err(error))
  }) as Promise<Effect<A, E, Requirements>>

const asTaggedResult = (
  result: ResultType<unknown, unknown>
): ResultType<unknown, TaggedErrorLike> => {
  // SAFETY: The public matcher overload restricts error values to TaggedErrorLike before reaching this runtime boundary.
  return result as ResultType<unknown, TaggedErrorLike>
}

const matchErrorResult = <
  A,
  E extends TaggedErrorLike,
  Requirements extends AnyService,
  Handlers extends TaggedErrorHandlers<E>
>(
  result: ResultType<A, E>,
  handlers: Handlers
): Effect<A, HandlerReturn<Handlers>, Requirements> => {
  // SAFETY: Result.mapError selects Err and preserves Ok; the declaration-only Effect marker is restored here.
  return Result.mapError(result, (error) => resultMatchError(error, handlers)) as Effect<
    A,
    HandlerReturn<Handlers>,
    Requirements
  >
}

const matchErrorPartialResult = <
  A,
  E extends TaggedErrorLike,
  Requirements extends AnyService,
  Handlers extends Partial<TaggedErrorHandlers<E>>
>(
  result: ResultType<A, E>,
  handlers: Handlers
): Effect<A, HandlerReturn<Handlers> | E, Requirements> => {
  // SAFETY: Result.mapError selects Err and preserves Ok; the declaration-only Effect marker is restored here.
  return Result.mapError(result, (error) => resultMatchErrorPartial(error, handlers)) as Effect<
    A,
    HandlerReturn<Handlers> | E,
    Requirements
  >
}

const recoverResult = <
  A,
  E,
  B,
  E2,
  Requirements1 extends AnyService,
  Requirements2 extends AnyService
>(
  result: ResultType<A, E>,
  fn: (error: E) => ResultType<B, E2>
): Effect<A | B, E2, Requirements1 | Requirements2> =>
  // SAFETY: Result.tryRecover owns recovery and short-circuiting; only Effect metadata is restored here.
  Result.tryRecover(result, fn) as Effect<A | B, E2, Requirements1 | Requirements2>

const recoverAsyncResult = <
  A,
  E,
  B,
  E2,
  Requirements1 extends AnyService,
  Requirements2 extends AnyService
>(
  result: ResultType<A, E>,
  fn: (error: E) => PromiseLike<ResultType<B, E2>>
): Promise<Effect<A | B, E2, Requirements1 | Requirements2>> =>
  // SAFETY: Result.tryRecoverAsync owns asynchronous recovery; only Effect metadata is restored here.
  Result.tryRecoverAsync(result, (error) => Promise.resolve(fn(error))) as Promise<
    Effect<A | B, E2, Requirements1 | Requirements2>
  >

const flattenResult = <
  A,
  E1,
  E2,
  Requirements1 extends AnyService,
  Requirements2 extends AnyService
>(
  result: ResultType<ResultType<A, E2>, E1>
): Effect<A, E1 | E2, Requirements1 | Requirements2> =>
  // SAFETY: Result.flatten removes one Result layer; the outer and inner Effect markers are restored here.
  Result.flatten(result) as Effect<A, E1 | E2, Requirements1 | Requirements2>

const matchResult = <A, E, OkResult, ErrResult>(
  result: ResultType<A, E>,
  handlers: { ok: (value: A) => OkResult; err: (error: E) => ErrResult }
): OkResult | ErrResult =>
  // SAFETY: Result.match invokes only the selected branch; handler Results remain ordinary runtime values.
  Result.match(result, handlers as never) as OkResult | ErrResult

const allResult = <const Results extends readonly AnyEffectValue[]>(
  results: Results
): AllResult<Results> =>
  // SAFETY: Result.all preserves tuple order and short-circuiting; the declaration-only channels are restored here.
  Result.all(results as readonly ResultType<any, any>[]) as AllResult<Results>

/** Observe a successful value without changing the Result. */
export function tap(fn: (value: any) => void): TapOperation
export function tap<Input>(
  effect: Input & AnyEffectInput,
  fn: (value: EffectSuccess<Input>) => void
): PreserveAsync<Input, TappedResult<Input>>
export function tap(first: CombinatorInput, second?: CombinatorCallback): any {
  if (first instanceof Function && second === undefined) {
    const callback = first
    return (effect: AnyEffectInput) => tap(effect, callback)
  }

  if (second === undefined) {
    throw new TypeError('Effect.tap requires a callback')
  }

  const fn = second
  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) => tapResult(asResult(result), fn))
  }

  return tapResult(asResult(first), fn)
}

/** Observe an error value without changing the Result. */
export function tapError(fn: (error: any) => void): TapErrorOperation
export function tapError<Input>(
  effect: Input & AnyEffectInput,
  fn: (error: EffectError<Input>) => void
): PreserveAsync<Input, TappedResult<Input>>
export function tapError(first: CombinatorInput, second?: CombinatorCallback): any {
  if (first instanceof Function && second === undefined) {
    const callback = first
    return (effect: AnyEffectInput) => tapError(effect, callback)
  }

  if (second === undefined) {
    throw new TypeError('Effect.tapError requires a callback')
  }

  const fn = second
  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) => tapErrorResult(asResult(result), fn))
  }

  return tapErrorResult(asResult(first), fn)
}

/** Observe whichever Result branch is active without changing the Result. */
export function tapBoth(handlers: {
  ok: (value: any) => void
  err: (error: any) => void
}): TapBothOperation
export function tapBoth<Input>(
  effect: Input & AnyEffectInput,
  handlers: {
    ok: (value: EffectSuccess<Input>) => void
    err: (error: EffectError<Input>) => void
  }
): PreserveAsync<Input, TappedResult<Input>>
export function tapBoth(first: any, second?: any): any {
  if (second === undefined) {
    return (effect: AnyEffectInput) => tapBoth(effect, first)
  }

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) => tapBothResult(result, second))
  }

  return tapBothResult(asResult(first), second)
}

/** Observe a successful value asynchronously without changing the Result. */
export function tapAsync(fn: (value: any) => PromiseLike<void>): TapAsyncOperation
export function tapAsync<Input>(
  effect: Input & AnyEffectInput,
  fn: (value: EffectSuccess<Input>) => PromiseLike<void>
): Promise<TappedResult<Input>>
export function tapAsync(first: CombinatorInput, second?: CombinatorCallback): any {
  if (first instanceof Function && second === undefined) {
    const callback = first
    return (effect: AnyEffectInput) => tapAsync(effect, callback)
  }

  if (second === undefined) {
    throw new TypeError('Effect.tapAsync requires a callback')
  }

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) => tapAsyncResult(asResult(result), second))
  }

  return tapAsyncResult(asResult(first), second)
}

/** Observe an error value asynchronously without changing the Result. */
export function tapErrorAsync(fn: (error: any) => PromiseLike<void>): TapErrorAsyncOperation
export function tapErrorAsync<Input>(
  effect: Input & AnyEffectInput,
  fn: (error: EffectError<Input>) => PromiseLike<void>
): Promise<TappedResult<Input>>
export function tapErrorAsync(first: CombinatorInput, second?: CombinatorCallback): any {
  if (first instanceof Function && second === undefined) {
    const callback = first
    return (effect: AnyEffectInput) => tapErrorAsync(effect, callback)
  }

  if (second === undefined) {
    throw new TypeError('Effect.tapErrorAsync requires a callback')
  }

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) => tapErrorAsyncResult(asResult(result), second))
  }

  return tapErrorAsyncResult(asResult(first), second)
}

/** Observe the active Result branch asynchronously without changing the Result. */
export function tapBothAsync(handlers: {
  ok: (value: any) => PromiseLike<void>
  err: (error: any) => PromiseLike<void>
}): TapBothAsyncOperation
export function tapBothAsync<Input>(
  effect: Input & AnyEffectInput,
  handlers: {
    ok: (value: EffectSuccess<Input>) => PromiseLike<void>
    err: (error: EffectError<Input>) => PromiseLike<void>
  }
): Promise<TappedResult<Input>>
export function tapBothAsync(first: any, second?: any): any {
  if (second === undefined) {
    return (effect: AnyEffectInput) => tapBothAsync(effect, first)
  }

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) => tapBothAsyncResult(result, second))
  }

  return tapBothAsyncResult(asResult(first), second)
}

/** Match every tagged error variant and map it to a new error value. */
export function matchError<Input, Handlers extends TaggedErrorHandlersFor<Input>>(
  effect: Input & AnyEffectInput,
  handlers: Handlers
): PreserveAsync<Input, MatchErrorResult<Input, Handlers>>
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- overload implementation is narrowed by the typed public signature.
export function matchError(first: AnyEffectInput, second?: unknown): any {
  if (second === undefined) {
    throw new TypeError('Effect.matchError requires handlers')
  }

  // SAFETY: The public matcher overload checks the handler map against the source tagged-error union.
  const handlers = second as TaggedErrorHandlers<TaggedErrorLike>

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) =>
      matchErrorResult(asTaggedResult(asResult(result)), handlers)
    )
  }

  return matchErrorResult(asTaggedResult(asResult(first)), handlers)
}

/** Match selected tagged errors and retain unhandled variants unchanged. */
export function matchErrorPartial<Input, Handlers extends Partial<TaggedErrorHandlersFor<Input>>>(
  effect: Input & AnyEffectInput,
  handlers: Handlers
): PreserveAsync<Input, MatchErrorPartialResult<Input, Handlers>>
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- overload implementation is narrowed by the typed public signature.
export function matchErrorPartial(first: AnyEffectInput, second?: unknown): any {
  if (second === undefined) {
    throw new TypeError('Effect.matchErrorPartial requires handlers')
  }

  // SAFETY: The public matcher overload checks the handler map against the source tagged-error union.
  const handlers = second as Partial<TaggedErrorHandlers<TaggedErrorLike>>

  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) =>
      matchErrorPartialResult(asTaggedResult(asResult(result)), handlers)
    )
  }

  return matchErrorPartialResult(asTaggedResult(asResult(first)), handlers)
}

/** Recover an Err with a synchronous Result-producing callback. */
export function recover<Next extends AnyEffectValue>(
  fn: (error: any) => Next
): RecoverOperation<Next>
export function recover<Input, Next extends AnyEffectValue>(
  effect: Input & AnyEffectInput,
  fn: (error: EffectError<Input>) => Next
): PreserveAsync<Input, RecoveredResult<Input, Next>>
export function recover(first: CombinatorInput, second?: CombinatorCallback): any {
  if (first instanceof Function && second === undefined) {
    const callback = first
    return (effect: AnyEffectInput) => recover(effect, callback)
  }

  if (second === undefined) {
    throw new TypeError('Effect.recover requires a callback')
  }

  const fn = second
  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) => recoverResult(asResult(result), fn))
  }

  return recoverResult(asResult(first), fn)
}

/** Recover an Err with an asynchronous Result-producing callback. */
export function recoverAsync<Next extends AnyAsyncEffectInput>(
  fn: (error: any) => Next
): RecoverAsyncOperation<Next>
export function recoverAsync<Input, Next extends AnyAsyncEffectInput>(
  effect: Input & AnyEffectInput,
  fn: (error: EffectError<Input>) => Next
): Promise<RecoveredResult<Input, Next>>
export function recoverAsync(first: CombinatorInput, second?: CombinatorCallback): any {
  if (first instanceof Function && second === undefined) {
    const callback = first
    return (effect: AnyEffectInput) => recoverAsync(effect, callback)
  }

  if (second === undefined) {
    throw new TypeError('Effect.recoverAsync requires a callback')
  }

  const fn = second
  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) => recoverAsyncResult(asResult(result), fn))
  }

  return recoverAsyncResult(asResult(first), fn)
}

/** Remove one nested Result/Effect layer. */
export function flatten<Input>(effect: Input & AnyEffectValue): FlattenedResult<Input> {
  // SAFETY: flattenResult restores the nested Effect channels after Result.flatten removes one runtime layer.
  return flattenResult(asResult(effect)) as FlattenedResult<Input>
}

/** Replace a successful value while preserving errors and requirements. */
export function as<Value>(
  value: Value
): <Input>(effect: Input & AnyEffectValue) => AsResult<Input, Value>
export function as<Input, Value>(
  effect: Input & AnyEffectValue,
  value: Value
): AsResult<Input, Value>
export function as(first: any, second?: any): any {
  if (arguments.length < 2) {
    return (effect: AnyEffectValue) => as(effect, first)
  }

  return mapResult(asResult(first), () => second)
}

/** Replace a successful value with void. */
export function asVoid<Input>(effect: Input & AnyEffectValue): AsResult<Input, void> {
  return mapResult(asResult(effect), () => undefined)
}

/** Match an Effect and return branch Effects with their channels unioned. */
export function match<Input, OkResult extends AnyEffectValue, ErrResult extends AnyEffectValue>(
  effect: Input & AnyEffectValue,
  handlers: {
    ok: (value: EffectSuccess<Input>) => OkResult
    err: (error: EffectError<Input>) => ErrResult
  }
): PreserveAsync<Input, MatchedResult<Input, OkResult, ErrResult>>
export function match<Input, OkValue, ErrValue>(
  effect: Input & AnyEffectValue,
  handlers: {
    ok: (value: EffectSuccess<Input>) => OkValue
    err: (error: EffectError<Input>) => ErrValue
  }
): PreserveAsync<Input, OkValue | ErrValue>
export function match(first: AnyEffectInput, second?: any): any {
  if (isPromiseLike(first)) {
    return Promise.resolve(first).then((result) => match(asResult(result), second))
  }

  return matchResult(asResult(first), second)
}

/** Collect already-created Effects in input order. */
export function all<const Results extends readonly AnyEffectValue[]>(
  results: Results
): AllResult<Results> {
  return allResult(results)
}

/** Combine two already-created Effects in input order. */
export function zip<Left, Right>(
  left: Left & AnyEffectValue,
  right: Right & AnyEffectValue
): ZipResult<Left, Right> {
  // SAFETY: Result.all returns the ordered pair; ZipResult restores only the declaration-only Effect channels.
  return Result.all([left, right]) as ZipResult<Left, Right>
}
