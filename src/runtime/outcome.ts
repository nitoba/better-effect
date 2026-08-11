import { Result } from 'better-result'

import type { Result as ResultType } from 'better-result'

import type { LayerDisposeError } from '../layer/errors'

import type { CleanupFailureDiagnostic, MaybePromise, ScopeOutcome } from '../scope'

export type RuntimeShutdownDiagnostic = {
  readonly outcome: ScopeOutcome
  readonly error: LayerDisposeError
}

export type CleanupFailureObserver = (
  diagnostic: CleanupFailureDiagnostic | RuntimeShutdownDiagnostic
) => MaybePromise<void>

export type RuntimeOptions = {
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
