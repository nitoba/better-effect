import { Result } from 'better-result'

import type { Result as ResultType } from 'better-result'

import type { LayerDisposeError } from '../layer/errors'

import type { LayerBackend } from '../layer/backend'

import type { CleanupFailureDiagnostic, MaybePromise, ScopeOutcome } from '../scope'

import type { RuntimeContextStorage } from './context'

import type { RuntimeObserver } from './observer'

/** Aggregated cleanup information reported during Runtime shutdown. */
export type RuntimeShutdownDiagnostic = {
  /** Final outcome supplied to the Runtime root Scope. */
  readonly outcome: ScopeOutcome
  /** Aggregated root-Scope and backend cleanup failure. */
  readonly error: LayerDisposeError
}

/** Observer notified about cleanup failures without changing primary results. */
export type CleanupFailureObserver = (
  diagnostic: CleanupFailureDiagnostic | RuntimeShutdownDiagnostic
) => MaybePromise<void>

/** Optional Runtime configuration for cleanup diagnostics. */
export type RuntimeOptions = {
  /** Backend used to register and resolve the Layer. Defaults to MapLayerBackend. */
  readonly backend?: LayerBackend
  /** Resolve every Layer provider before Runtime.make resolves. */
  readonly warmup?: boolean
  /** Best-effort lifecycle and Service resolution observers. */
  readonly observers?: readonly RuntimeObserver[]
  /** Optional observer for best-effort cleanup diagnostics. */
  readonly onCleanupFailure?: CleanupFailureObserver
  /** Context storage used by Service, Scope and Layer resolution. */
  readonly contextStorage?: RuntimeContextStorage
  /** Optional signal exposed through the RuntimeContext. */
  readonly signal?: AbortSignal
}

/** Optional signal supplied to one managed Runtime execution. */
export type RuntimeRunOptions = {
  readonly signal?: AbortSignal
}

/** Cooperative shutdown policy for a managed Runtime. */
export type RuntimeDisposeOptions = {
  /** Time to let active executions settle before requesting cancellation. */
  readonly gracePeriod?: number
  /** Abort active execution signals after the grace period expires. */
  readonly abortAfterGracePeriod?: boolean
}

type ResultLike = ResultType<any, any>

const isResultLike = <A>(value: A): value is A & ResultLike => {
  const candidate = Object(value)
  const tag = Object.prototype.toString.call(value)

  return (
    tag !== '[object Function]' &&
    'status' in candidate &&
    (candidate.status === 'ok' || candidate.status === 'error')
  )
}

export const classifyRuntimeOutcome = <A>(value: A): ScopeOutcome => {
  if (isResultLike(value) && Result.isError(value)) {
    return {
      status: 'failure',
      cause: value.error
    }
  }

  return {
    status: 'success'
  }
}
