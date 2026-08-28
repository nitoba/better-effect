import { Result } from 'better-result'

import type { Result as ResultType } from 'better-result'

import type { AnyService } from '../service'
import { isPromiseLike } from '../utils/runtime'

import type { EffectError, EffectRequirements, EffectSuccess, Program } from './types'

type AnyResult = ResultType<any, any>
type RuntimeEffect = AnyResult | PromiseLike<AnyResult>
type RuntimeProgram = () => RuntimeEffect
type RuntimeProgramOutput = RuntimeEffect | RuntimeProgram
type RuntimeCallback = (value: any) => any
type RuntimeContinuation = (value: any) => RuntimeProgramOutput
type AnyProgram = Program<any, any, AnyService>

type ProgramInput<Input extends RuntimeProgram> = Input &
  Program<EffectSuccess<Input>, EffectError<Input>, EffectRequirements<Input>>

type CompatibleSuccess<Input, A> = EffectSuccess<Input> extends A ? unknown : never
type CompatibleError<Input, E> = EffectError<Input> extends E ? unknown : never

type ProgramOutput<Output> =
  Output extends Program<infer _Success, infer _Error, infer _Requirements extends AnyService>
    ? Output
    : Output extends PromiseLike<infer AsyncOutput>
      ? AsyncOutput extends ResultType<infer _Success, infer _Error>
        ? Output
        : never
      : Output extends ResultType<infer _Success, infer _Error>
        ? Output
        : never

type MappedProgram<Input, B> = Program<B, EffectError<Input>, EffectRequirements<Input>>

type ErrorMappedProgram<Input, E2> = Program<EffectSuccess<Input>, E2, EffectRequirements<Input>>

type ChainedProgram<Input, Next> = Program<
  EffectSuccess<Next>,
  EffectError<Input> | EffectError<Next>,
  EffectRequirements<Input> | EffectRequirements<Next>
>

type TappedProgram<Input> = Program<
  EffectSuccess<Input>,
  EffectError<Input>,
  EffectRequirements<Input>
>

type RecoveredProgram<Input, Next> = Program<
  EffectSuccess<Input> | EffectSuccess<Next>,
  EffectError<Next>,
  EffectRequirements<Input> | EffectRequirements<Next>
>

type MapOperation<A, B> = {
  <Input extends RuntimeProgram>(
    program: ProgramInput<Input> & CompatibleSuccess<Input, A>
  ): MappedProgram<Input, B>
}

type MapErrorOperation<E1, E2> = {
  <Input extends RuntimeProgram>(
    program: ProgramInput<Input> & CompatibleError<Input, E1>
  ): ErrorMappedProgram<Input, E2>
}

type AndThenOperation<A, Next> = {
  <Input extends RuntimeProgram>(
    program: ProgramInput<Input> & CompatibleSuccess<Input, A>
  ): ChainedProgram<Input, Next>
}

type TapOperation<A> = {
  <Input extends RuntimeProgram>(
    program: ProgramInput<Input> & CompatibleSuccess<Input, A>
  ): TappedProgram<Input>
}

type TapErrorOperation<E> = {
  <Input extends RuntimeProgram>(
    program: ProgramInput<Input> & CompatibleError<Input, E>
  ): TappedProgram<Input>
}

type RecoverOperation<E, Next> = {
  <Input extends RuntimeProgram>(
    program: ProgramInput<Input> & CompatibleError<Input, E>
  ): RecoveredProgram<Input, Next>
}

const asProgram = <Output extends AnyProgram>(program: RuntimeProgram): Output =>
  // SAFETY: Program's channels and nominal marker are declaration-only; callers derive them from typed inputs.
  program as Output

const isAsyncEffect = (effect: RuntimeEffect): effect is PromiseLike<AnyResult> =>
  isPromiseLike(effect)

const mapRuntime = (effect: RuntimeEffect, fn: RuntimeCallback): RuntimeEffect => {
  if (isAsyncEffect(effect)) {
    return Promise.resolve(effect).then((result) => Result.map(result, fn))
  }

  return Result.map(effect, fn)
}

const mapErrorRuntime = (effect: RuntimeEffect, fn: RuntimeCallback): RuntimeEffect => {
  if (isAsyncEffect(effect)) {
    return Promise.resolve(effect).then((result) => Result.mapError(result, fn))
  }

  return Result.mapError(effect, fn)
}

const tapRuntime = (effect: RuntimeEffect, fn: RuntimeCallback): RuntimeEffect => {
  if (isAsyncEffect(effect)) {
    return Promise.resolve(effect).then((result) => Result.tap(result, fn))
  }

  return Result.tap(effect, fn)
}

const tapErrorRuntime = (effect: RuntimeEffect, fn: RuntimeCallback): RuntimeEffect => {
  if (isAsyncEffect(effect)) {
    return Promise.resolve(effect).then((result) => Result.tapError(result, fn))
  }

  return Result.tapError(effect, fn)
}

const invoke = (output: RuntimeProgramOutput): RuntimeEffect =>
  output instanceof Function ? output() : output

const andThenRuntime = (effect: RuntimeEffect, next: RuntimeContinuation): Promise<AnyResult> => {
  const continueWith = (value: any) => Promise.resolve(invoke(next(value)))

  if (isAsyncEffect(effect)) {
    return Promise.resolve(effect).then((result) => Result.andThenAsync(result, continueWith))
  }

  return Result.andThenAsync(effect, continueWith)
}

const recoverRuntime = (
  effect: RuntimeEffect,
  recover: RuntimeContinuation
): Promise<AnyResult> => {
  const continueWith = (error: any) => Promise.resolve(invoke(recover(error)))

  if (isAsyncEffect(effect)) {
    return Promise.resolve(effect).then((result) => Result.tryRecoverAsync(result, continueWith))
  }

  return Result.tryRecoverAsync(effect, continueWith)
}

const mapProgram = <Input extends RuntimeProgram, B>(
  program: ProgramInput<Input>,
  fn: (value: EffectSuccess<Input>) => B
): MappedProgram<Input, B> => asProgram<MappedProgram<Input, B>>(() => mapRuntime(program(), fn))

const mapErrorProgram = <Input extends RuntimeProgram, E2>(
  program: ProgramInput<Input>,
  fn: (error: EffectError<Input>) => E2
): ErrorMappedProgram<Input, E2> =>
  asProgram<ErrorMappedProgram<Input, E2>>(() => mapErrorRuntime(program(), fn))

const tapProgram = <Input extends RuntimeProgram>(
  program: ProgramInput<Input>,
  fn: (value: EffectSuccess<Input>) => any
): TappedProgram<Input> => asProgram<TappedProgram<Input>>(() => tapRuntime(program(), fn))

const tapErrorProgram = <Input extends RuntimeProgram>(
  program: ProgramInput<Input>,
  fn: (error: EffectError<Input>) => any
): TappedProgram<Input> => asProgram<TappedProgram<Input>>(() => tapErrorRuntime(program(), fn))

/** Lazily map the successful Result value of a Program. */
export function map<A, B>(fn: (value: A) => B): MapOperation<A, B>
export function map<Input extends RuntimeProgram, B>(
  program: ProgramInput<Input>,
  fn: (value: EffectSuccess<Input>) => B
): MappedProgram<Input, B>
export function map(first: RuntimeProgram | RuntimeCallback, second?: RuntimeCallback): any {
  if (second === undefined) {
    return (program: RuntimeProgram) => {
      // SAFETY: The curried overload supplies a Program and a callback that accepts its success channel.
      return mapProgram(program as ProgramInput<typeof program>, first)
    }
  }

  // SAFETY: The data-first overload supplies a Program as its first argument.
  return mapProgram(first as ProgramInput<RuntimeProgram>, second)
}

/** Lazily map the error Result value of a Program. */
export function mapError<E1, E2>(fn: (error: E1) => E2): MapErrorOperation<E1, E2>
export function mapError<Input extends RuntimeProgram, E2>(
  program: ProgramInput<Input>,
  fn: (error: EffectError<Input>) => E2
): ErrorMappedProgram<Input, E2>
export function mapError(first: RuntimeProgram | RuntimeCallback, second?: RuntimeCallback): any {
  if (second === undefined) {
    return (program: RuntimeProgram) => {
      // SAFETY: The curried overload supplies a Program and a callback that accepts its error channel.
      return mapErrorProgram(program as ProgramInput<typeof program>, first)
    }
  }

  // SAFETY: The data-first overload supplies a Program as its first argument.
  return mapErrorProgram(first as ProgramInput<RuntimeProgram>, second)
}

/** Lazily continue a successful Program with an Effect or Program. */
export function andThen<A, Next>(
  next: (value: A) => Next & ProgramOutput<Next>
): AndThenOperation<A, Next>
export function andThen<Input extends RuntimeProgram, Next>(
  program: ProgramInput<Input>,
  next: (value: EffectSuccess<Input>) => Next & ProgramOutput<Next>
): ChainedProgram<Input, Next>
export function andThen(
  first: RuntimeProgram | RuntimeContinuation,
  second?: RuntimeContinuation
): any {
  if (second === undefined) {
    return (program: RuntimeProgram) =>
      // SAFETY: The curried overload supplies a Program and a continuation for its success channel.
      () =>
        andThenRuntime(program(), first as RuntimeContinuation)
  }

  // SAFETY: The data-first overload supplies a Program as its first argument.
  return () => andThenRuntime((first as RuntimeProgram)(), second)
}

/** Lazily observe a successful Program value without changing its Result. */
export function tap<A>(fn: (value: A) => void): TapOperation<A>
export function tap<Input extends RuntimeProgram>(
  program: ProgramInput<Input>,
  fn: (value: EffectSuccess<Input>) => void
): TappedProgram<Input>
export function tap(first: RuntimeProgram | RuntimeCallback, second?: RuntimeCallback): any {
  if (second === undefined) {
    return (program: RuntimeProgram) => {
      // SAFETY: The curried overload supplies a Program and a callback that accepts its success channel.
      return tapProgram(program as ProgramInput<typeof program>, first)
    }
  }

  // SAFETY: The data-first overload supplies a Program as its first argument.
  return tapProgram(first as ProgramInput<RuntimeProgram>, second)
}

/** Lazily observe a failed Program value without changing its Result. */
export function tapError<E>(fn: (error: E) => void): TapErrorOperation<E>
export function tapError<Input extends RuntimeProgram>(
  program: ProgramInput<Input>,
  fn: (error: EffectError<Input>) => void
): TappedProgram<Input>
export function tapError(first: RuntimeProgram | RuntimeCallback, second?: RuntimeCallback): any {
  if (second === undefined) {
    return (program: RuntimeProgram) => {
      // SAFETY: The curried overload supplies a Program and a callback that accepts its error channel.
      return tapErrorProgram(program as ProgramInput<typeof program>, first)
    }
  }

  // SAFETY: The data-first overload supplies a Program as its first argument.
  return tapErrorProgram(first as ProgramInput<RuntimeProgram>, second)
}

/** Lazily recover a failed Program with an Effect or Program. */
export function recover<E, Next>(
  fn: (error: E) => Next & ProgramOutput<Next>
): RecoverOperation<E, Next>
export function recover<Input extends RuntimeProgram, Next>(
  program: ProgramInput<Input>,
  recover: (error: EffectError<Input>) => Next & ProgramOutput<Next>
): RecoveredProgram<Input, Next>
export function recover(
  first: RuntimeProgram | RuntimeContinuation,
  second?: RuntimeContinuation
): any {
  if (second === undefined) {
    return (program: RuntimeProgram) =>
      // SAFETY: The curried overload supplies a Program and a recovery callback for its error channel.
      () =>
        recoverRuntime(program(), first as RuntimeContinuation)
  }

  // SAFETY: The data-first overload supplies a Program as its first argument.
  return () => recoverRuntime((first as RuntimeProgram)(), second)
}
