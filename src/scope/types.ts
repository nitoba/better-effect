import type { ScopeCloseError } from './errors'

export type MaybePromise<T> = T | PromiseLike<T>

export type ScopeOutcome =
  | {
      readonly status: 'success'
    }
  | {
      readonly status: 'failure'
      readonly cause: unknown
    }

export type ScopeFinalizer = (outcome: ScopeOutcome) => MaybePromise<void>

export type CleanupFailureDiagnostic = {
  readonly outcome: ScopeOutcome
  readonly error: ScopeCloseError
}

export type DisposableResource = {
  [Symbol.dispose]?: () => void

  [Symbol.asyncDispose]?: () => MaybePromise<void>
}
