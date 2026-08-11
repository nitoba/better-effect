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

type SyncDisposableResource = {
  [Symbol.dispose]: () => void

  [Symbol.asyncDispose]?: () => MaybePromise<void>
}

type AsyncDisposableResource = {
  [Symbol.dispose]?: () => void

  [Symbol.asyncDispose]: () => MaybePromise<void>
}

export type DisposableResource = SyncDisposableResource | AsyncDisposableResource
