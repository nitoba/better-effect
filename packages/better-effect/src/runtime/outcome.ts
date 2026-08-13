import { Result } from 'better-result'

import type { Result as ResultType } from 'better-result'

import type { LayerDisposeError } from '../layer/errors'

import type { CleanupFailureDiagnostic, MaybePromise, ScopeOutcome } from '../scope'

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
  /** Optional observer for best-effort cleanup diagnostics. */
  readonly onCleanupFailure?: CleanupFailureObserver
}

const isResultLike = (value: unknown): value is ResultType<unknown, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  'status' in value &&
  (value.status === 'ok' || value.status === 'error')

export const classifyRuntimeOutcome = (value: unknown): ScopeOutcome => {
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
