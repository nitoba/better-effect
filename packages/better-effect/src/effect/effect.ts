import { Err, Result } from 'better-result'

import type { Result as ResultType, UnhandledException } from 'better-result'

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
  recover,
  recoverAsync,
  tap,
  tapBoth,
  tapError,
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

const validateProgramConcurrency = (concurrency: number | undefined): void => {
  if (
    concurrency !== undefined &&
    (!Number.isFinite(concurrency) || !Number.isInteger(concurrency) || concurrency <= 0)
  ) {
    throw new RangeError('Program.all concurrency must be a positive integer')
  }
}

/** Build a lazy Program collection with optional bounded concurrency. */
export function programAll<const Programs extends readonly AnyProgram[]>(
  programs: Programs,
  options: ProgramAllOptions = {}
): ProgramAllResult<Programs> {
  validateProgramConcurrency(options.concurrency)

  const concurrency = options.concurrency
  const program = async (): Promise<AnyResult> => {
    const results: Array<AnyResult | undefined> = Array.from({ length: programs.length })
    const failures: boolean[] = Array.from({ length: programs.length }, () => false)
    const causes: unknown[] = Array.from({ length: programs.length })
    let nextIndex = 0
    let stopScheduling = false

    const worker = async (): Promise<void> => {
      while (!stopScheduling) {
        const index = nextIndex++

        if (index >= programs.length) {
          return
        }

        try {
          const result = await programs[index]!()
          results[index] = result

          if (result instanceof Err) {
            stopScheduling = true
          }
        } catch (cause) {
          failures[index] = true
          causes[index] = cause
          stopScheduling = true
        }
      }
    }

    const workers = Math.min(concurrency ?? programs.length, programs.length)
    await Promise.all(Array.from({ length: workers }, () => worker()))

    const failureIndex = failures.findIndex(Boolean)

    if (failureIndex >= 0) {
      throw causes[failureIndex]
    }

    // SAFETY: Program's callable contract produces Result values; the array is erased only at this collection boundary.
    return Result.all(results as AnyResult[])
  }

  // SAFETY: Program channels are declaration-only and are restored from the input tuple here.
  return program as ProgramAllResult<Programs>
}

/** Value-level namespace for lazy Program combinators. */
export const Program = {
  all: programAll,
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
  readonly tapError: typeof tapError
  readonly tapBoth: typeof tapBoth
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
  /** Observe error values without changing the Result. */
  tapError,
  /** Observe the active Result branch without changing the Result. */
  tapBoth,
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
