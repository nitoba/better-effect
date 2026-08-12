import type { ScopeCloseError } from './errors'

/** A value that may be returned synchronously or asynchronously. */
export type MaybePromise<T> = T | PromiseLike<T>

/** Final outcome supplied to Scope finalizers and resource releases. */
export type ScopeOutcome =
  | {
      /** Indicates that the owning program completed successfully. */
      readonly status: 'success'
    }
  | {
      /** Indicates that the owning program failed or was interrupted. */
      readonly status: 'failure'
      /** The original program or execution failure. */
      readonly cause: unknown
    }

/** Cleanup callback registered with a Scope. */
export type ScopeFinalizer = (outcome: ScopeOutcome) => MaybePromise<void>

/** Aggregated cleanup information reported at an execution boundary. */
export type CleanupFailureDiagnostic = {
  /** Outcome used for the Scope close that triggered cleanup. */
  readonly outcome: ScopeOutcome
  /** Aggregated finalizer failure. */
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

/** A value implementing at least one JavaScript disposal protocol. */
export type DisposableResource = SyncDisposableResource | AsyncDisposableResource
