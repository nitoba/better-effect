import { Result } from 'better-result'

import type { Err, Result as ResultType, UnhandledException } from 'better-result'

import { Scope } from '../scope'

import type { DisposableResource, MaybePromise, ScopeOutcome } from '../scope'
import type { AnyService } from '../service'

import type {
  AnyEffect,
  Effect as EffectType,
  EffectError,
  EffectFromGenerator,
  EffectRequirements,
  EffectSuccess,
  EffectYield,
  Program as ProgramType,
  ProgramFromGenerator
} from './types'

import {
  all,
  andThen,
  andThenAsync,
  as,
  asVoid,
  flatten,
  map,
  mapError,
  match,
  matchError,
  matchErrorPartial,
  recover,
  recoverAsync,
  tap,
  tapAsync,
  tapBoth,
  tapBothAsync,
  tapError,
  tapErrorAsync,
  zip
} from './combinators'
import {
  andThen as programAndThen,
  map as programMap,
  mapError as programMapError,
  recover as programRecover,
  tap as programTap,
  tapError as programTapError
} from './program-combinators'
import {
  firstProgramFailure,
  runProgramCollection,
  validateProgramConcurrency
} from './program-scheduler'

export type Effect<A, E, R extends AnyService = never> = EffectType<A, E, R>

type LazyProgram<A, E, R extends AnyService = never> = ProgramType<A, E, R>

/** A nominal lazy computation that produces an Effect when invoked. */
export type Program<A, E, R extends AnyService = never> = LazyProgram<A, E, R>

type AnyResult = ResultType<any, any>

type AnyProgram = ProgramType<any, any, AnyService>

type ProgramAllSuccess<Programs extends readonly AnyProgram[]> = {
  -readonly [Index in keyof Programs]: EffectSuccess<Programs[Index]>
}

type ProgramAllError<Programs extends readonly AnyProgram[]> = EffectError<Programs[number]>

type ProgramAllRequirements<Programs extends readonly AnyProgram[]> = EffectRequirements<
  Programs[number]
>

type ProgramAllResult<Programs extends readonly AnyProgram[]> = ProgramType<
  ProgramAllSuccess<Programs>,
  ProgramAllError<Programs>,
  ProgramAllRequirements<Programs>
>

type ProgramResultFor<Child> = Child extends AnyProgram
  ? ResultType<EffectSuccess<Child>, EffectError<Child>>
  : never

type ProgramAllResultsSuccess<Programs extends readonly AnyProgram[]> =
  number extends Programs['length']
    ? ReadonlyArray<ResultType<EffectSuccess<Programs[number]>, EffectError<Programs[number]>>>
    : { readonly [Index in keyof Programs]: ProgramResultFor<Programs[Index]> }

type ProgramAllResultsResult<Programs extends readonly AnyProgram[]> = ProgramType<
  ProgramAllResultsSuccess<Programs>,
  never,
  ProgramAllRequirements<Programs>
>

type ProgramForEachResult<Child extends AnyProgram> = ProgramType<
  ReadonlyArray<EffectSuccess<Child>>,
  EffectError<Child>,
  EffectRequirements<Child>
>

export type ProgramAllOptions = {
  readonly concurrency?: number
}

type EffectGenerator =
  | (() => Generator<EffectYield, AnyResult, unknown>)
  | (() => AsyncGenerator<EffectYield, AnyResult, unknown>)

type RuntimeResultGenerator = (body: EffectGenerator) => AnyResult | Promise<AnyResult>

// SAFETY: Service iterators yield no runtime markers, so Result.gen receives only the Err values that exist at runtime.
const runResultGenerator = Result.gen as RuntimeResultGenerator

/**
 * Compose `better-result` operations while preserving Service requirements in
 * a declaration-only type channel.
 *
 * A generator may yield Service tokens and Result operations. It must return a
 * `Result` as its final value; Service yields are resolved by the active
 * Runtime and do not add runtime values to the Result stream.
 * Use `fn` when generator execution should wait for a Runtime boundary.
 *
 * @example
 * ```ts
 * const loadUser = Effect.gen(async function* () {
 *   const database = yield* Database
 *   const user = yield* Result.await(database.findUser('u1'))
 *
 *   return Result.ok(user)
 * })
 * ```
 */
export function gen<Yield extends EffectYield, Returned extends AnyResult>(
  body: () => Generator<Yield, Returned, unknown>
): EffectFromGenerator<Yield, Returned>

export function gen<Yield extends EffectYield, Returned extends AnyResult>(
  body: () => AsyncGenerator<Yield, Returned, unknown>
): Promise<EffectFromGenerator<Yield, Returned>>

export function gen(body: EffectGenerator): AnyResult | Promise<AnyResult> {
  return runResultGenerator(body)
}

/** Build a lazy Program without running its generator. */
export function fn<Yield extends EffectYield, Returned extends AnyResult>(
  body: () => Generator<Yield, Returned, unknown>
): ProgramFromGenerator<Yield, Returned>

export function fn<Yield extends EffectYield, Returned extends AnyResult>(
  body: () => AsyncGenerator<Yield, Returned, unknown>
): ProgramFromGenerator<Yield, Returned>

export function fn(body: EffectGenerator): Program<any, any, AnyService> {
  const program = () => runResultGenerator(body)

  // SAFETY: The generator overloads derive the Program channels; this cast only adds the declaration-only nominal marker.
  return program as Program<any, any, AnyService>
}

const runShortCircuitingCollection = async (
  length: number,
  task: (index: number) => AnyResult | PromiseLike<AnyResult>,
  concurrency: number | undefined
): Promise<AnyResult> => {
  const outcome = await runProgramCollection(length, task, {
    concurrency,
    stopOnResultError: true
  })
  const failure = firstProgramFailure(outcome.failures)

  if (failure?.kind === 'defect') {
    throw failure.cause
  }

  if (failure?.kind === 'result') {
    return failure.result
  }

  // SAFETY: The scheduler records one Result per claimed index before completing successfully.
  return Result.all(outcome.results as AnyResult[])
}

const runAllResultsCollection = async (
  length: number,
  task: (index: number) => AnyResult | PromiseLike<AnyResult>,
  concurrency: number | undefined
): Promise<AnyResult> => {
  const outcome = await runProgramCollection(length, task, {
    concurrency,
    stopOnResultError: false
  })
  const failure = firstProgramFailure(outcome.failures)

  if (failure?.kind === 'defect') {
    throw failure.cause
  }

  // SAFETY: The scheduler records each successful Result object at its input index.
  return Result.ok(outcome.results as AnyResult[])
}

/** Build a lazy Program collection with optional bounded concurrency. */
export function programAll<const Programs extends readonly AnyProgram[]>(
  programs: Programs,
  options: ProgramAllOptions = {}
): ProgramAllResult<Programs> {
  const concurrency = options.concurrency
  validateProgramConcurrency(concurrency)
  const program = () =>
    runShortCircuitingCollection(programs.length, (index) => programs[index]!(), concurrency)

  // SAFETY: Program channels are declaration-only and are restored from the input tuple here.
  return program as ProgramAllResult<Programs>
}

/** Build a lazy Program collection from an input array and Program factory. */
export function programForEach<const Items extends readonly unknown[], Child extends AnyProgram>(
  items: Items,
  makeProgram: (item: Items[number], index: number) => Child,
  options: ProgramAllOptions = {}
): ProgramForEachResult<Child> {
  const concurrency = options.concurrency
  validateProgramConcurrency(concurrency)
  const program = () =>
    runShortCircuitingCollection(
      items.length,
      (index) => makeProgram(items[index]!, index)(),
      concurrency
    )

  // SAFETY: Program channels are declaration-only and are restored from the factory's result type.
  return program as ProgramForEachResult<Child>
}

/** Build a lazy Program collection that retains every child Result. */
export function programAllResults<const Programs extends readonly AnyProgram[]>(
  programs: Programs,
  options: ProgramAllOptions = {}
): ProgramAllResultsResult<Programs> {
  const concurrency = options.concurrency
  validateProgramConcurrency(concurrency)
  const program = () =>
    runAllResultsCollection(programs.length, (index) => programs[index]!(), concurrency)

  // SAFETY: Program channels are declaration-only and are restored from the input tuple here.
  return program as ProgramAllResultsResult<Programs>
}

/** Value-level namespace for lazy Program combinators. */
export const Program = {
  all: programAll,
  forEach: programForEach,
  allResults: programAllResults,
  map: programMap,
  mapError: programMapError,
  andThen: programAndThen,
  tap: programTap,
  tapError: programTapError,
  recover: programRecover
} as const

/**
 * Acquire a resource in the current Scope and register its release callback.
 *
 * Acquisition failures are represented in the Effect Result error channel;
 * release failures remain owned by Scope cleanup. The release callback
 * receives the final outcome chosen by the enclosing execution boundary.
 *
 * @example
 * ```ts
 * const connection = yield* Effect.acquireRelease(
 *   () => pool.connect(),
 *   (connection, outcome) => connection.close(outcome)
 * )
 * ```
 */
export function acquireRelease<R>(
  acquire: () => MaybePromise<R>,
  release: (resource: R, outcome: ScopeOutcome) => MaybePromise<void>
): AsyncGenerator<Err<never, UnhandledException>, R, unknown> {
  const scope = Scope.current()

  return Result.await(Result.tryPromise(() => scope.acquire(acquire, release)))
}

/**
 * Register an already-acquired disposable resource in the current Scope.
 *
 * The resource is not acquired by this helper. Registration failures are
 * represented in the Effect Result error channel; disposal failures remain
 * owned by Scope cleanup.
 *
 * @example
 * ```ts
 * const file = yield* Effect.add(await openFile('notes.txt'))
 * ```
 */
export function add<R extends DisposableResource>(
  resource: R
): AsyncGenerator<Err<never, UnhandledException>, R, unknown> {
  const scope = Scope.current()

  return Result.await(Result.tryPromise(() => scope.add(resource)))
}

/**
 * Effect namespace containing generator, resource, and Result combinators.
 *
 * Prefer these helpers when a program needs typed Service requirements or
 * Scope-aware acquisition and cleanup.
 */
type EffectNamespace = {
  readonly gen: typeof gen
  readonly fn: typeof fn
  readonly acquireRelease: typeof acquireRelease
  readonly add: typeof add
  readonly map: typeof map
  readonly mapError: typeof mapError
  readonly andThen: typeof andThen
  readonly andThenAsync: typeof andThenAsync
  readonly tap: typeof tap
  readonly tapAsync: typeof tapAsync
  readonly tapError: typeof tapError
  readonly tapErrorAsync: typeof tapErrorAsync
  readonly tapBoth: typeof tapBoth
  readonly tapBothAsync: typeof tapBothAsync
  readonly matchError: typeof matchError
  readonly matchErrorPartial: typeof matchErrorPartial
  readonly recover: typeof recover
  readonly recoverAsync: typeof recoverAsync
  readonly flatten: typeof flatten
  readonly as: typeof as
  readonly asVoid: typeof asVoid
  readonly match: typeof match
  readonly all: typeof all
  readonly zip: typeof zip
}

export const Effect: EffectNamespace = {
  /** Compose a generator-based Effect program. */
  gen,
  /** Build a lazy Program from a generator. */
  fn,
  /** Acquire and register a resource in the current Scope. */
  acquireRelease,
  /** Register an already-acquired disposable in the current Scope. */
  add,
  /** Map a successful Effect result. */
  map,
  /** Map an Effect error. */
  mapError,
  /** Chain a synchronous Effect result. */
  andThen,
  /** Chain an asynchronous Effect result. */
  andThenAsync,
  /** Observe successful values without changing the Result. */
  tap,
  /** Observe successful values asynchronously without changing the Result. */
  tapAsync,
  /** Observe error values without changing the Result. */
  tapError,
  /** Observe error values asynchronously without changing the Result. */
  tapErrorAsync,
  /** Observe the active Result branch without changing the Result. */
  tapBoth,
  /** Observe the active Result branch asynchronously without changing the Result. */
  tapBothAsync,
  /** Match every tagged error variant and map it to a new error value. */
  matchError,
  /** Match selected tagged errors and retain unhandled variants. */
  matchErrorPartial,
  /** Recover an error with another Effect. */
  recover,
  /** Recover an error asynchronously with another Effect. */
  recoverAsync,
  /** Remove one nested Effect layer. */
  flatten,
  /** Replace a successful value. */
  as,
  /** Replace a successful value with void. */
  asVoid,
  /** Match either Result branch. */
  match,
  /** Collect Effects in input order. */
  all,
  /** Zip two Effects in input order. */
  zip
} as const

/** Type-level aliases for inspecting Effect result channels and requirements. */
export declare namespace Effect {
  /** A nominal lazy computation that produces an Effect when invoked. */
  export type Program<A, E, R extends AnyService = never> = LazyProgram<A, E, R>

  /** Extract the success channel from an Effect result or Promise. */
  export type Success<T> = EffectSuccess<T>

  /** Extract the error channel from an Effect result or Promise. */
  export type Error<T> = EffectError<T>

  /** Extract the Service requirements from an Effect result or Promise. */
  export type Requirements<T> = EffectRequirements<T>

  /** An Effect with erased success, error, and requirements. */
  export type Any = AnyEffect
}
