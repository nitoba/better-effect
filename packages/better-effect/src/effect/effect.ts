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
  EffectYield
} from './types'

import { andThen, andThenAsync, map, mapError } from './combinators'

export type Effect<A, E, R extends AnyService = never> = EffectType<A, E, R>

type AnyResult = ResultType<any, any>

type EffectGenerator =
  | (() => Generator<EffectYield, AnyResult, unknown>)
  | (() => AsyncGenerator<EffectYield, AnyResult, unknown>)

type RuntimeResultGenerator = (body: EffectGenerator) => AnyResult | Promise<AnyResult>

/**
 * Compose `better-result` operations while preserving Service requirements in
 * a phantom type channel.
 *
 * A generator may yield Service tokens and Result operations. It must return a
 * `Result` as its final value; Service yields are resolved by the active
 * Runtime and do not add runtime values to the Result stream.
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
  /*
   * ServiceRequirement is phantom. The Service iterator returns its resolved
   * instance without yielding a marker, so Result.gen still receives only
   * the Err values that exist at runtime.
   */
  // SAFETY: Service iterators yield no runtime markers, so the phantom Service yield channel is erased before delegating to better-result.
  const runResultGenerator = Result.gen as RuntimeResultGenerator

  return runResultGenerator(body)
}

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
export const Effect = {
  /** Compose a generator-based Effect program. */
  gen,
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
  andThenAsync
} as const

/** Type-level aliases for inspecting Effect result channels and requirements. */
export declare namespace Effect {
  /** Extract the success channel from an Effect result or Promise. */
  export type Success<T> = EffectSuccess<T>

  /** Extract the error channel from an Effect result or Promise. */
  export type Error<T> = EffectError<T>

  /** Extract the Service requirements from an Effect result or Promise. */
  export type Requirements<T> = EffectRequirements<T>

  /** An Effect with erased success, error, and requirements. */
  export type Any = AnyEffect
}
