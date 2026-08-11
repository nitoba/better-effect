import { Result } from 'better-result'

import type { Err, Result as ResultType, UnhandledException } from 'better-result'

import { Scope } from '../scope'

import type { MaybePromise, ScopeOutcome } from '../scope'

import type { EffectFromGenerator, EffectYield } from './types'

type AnyResult = ResultType<any, any>

type RuntimeGenerator =
  | (() => Generator<Err<never, unknown>, AnyResult, unknown>)
  | (() => AsyncGenerator<Err<never, unknown>, AnyResult, unknown>)

type EffectGenerator =
  | (() => Generator<EffectYield, AnyResult, unknown>)
  | (() => AsyncGenerator<EffectYield, AnyResult, unknown>)

/**
 * Compose better-result operations while preserving Service requirements in
 * a phantom type channel.
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
  return (Result.gen as unknown as (body: RuntimeGenerator) => AnyResult | Promise<AnyResult>)(
    body as RuntimeGenerator
  )
}

/**
 * Acquire a resource in the current Scope and register its release callback.
 *
 * Acquisition failures are represented in the Effect Result error channel;
 * release failures remain owned by Scope cleanup.
 */
export function acquireRelease<R>(
  acquire: () => MaybePromise<R>,
  release: (resource: R, outcome: ScopeOutcome) => MaybePromise<void>
): AsyncGenerator<Err<never, UnhandledException>, R, unknown> {
  const scope = Scope.current()

  return Result.await(Result.tryPromise(() => scope.acquire(acquire, release)))
}

export const Effect = {
  gen,
  acquireRelease
} as const
