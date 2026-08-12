import type { Result as ResultType } from 'better-result'

export type { DisposableResource } from '../scope/types'

import type { ResourceReleaseFailure } from './errors'

/** A value that may be delivered synchronously or through a thenable. */
export type MaybePromise<T> = T | PromiseLike<T>

/** A synchronous or asynchronous better-result Result operation. */
export type AsyncResult<T, E> = MaybePromise<ResultType<T, E>>

/** The allowed return value of a custom Resource release callback. */
export type ReleaseOutcome = void | ResultType<void, unknown>

/** Receives release failures for diagnostics without changing error precedence. */
export type ReleaseFailureObserver = (failure: ResourceReleaseFailure) => MaybePromise<void>

/** Options controlling `Resource.acquireUseRelease`. */
export type AcquireUseReleaseOptions<R, A, AcquireError, UseError> = {
  /** Human-readable name included in release failures. */
  readonly name: string

  /** Acquire the resource. A failure skips use and release. */
  readonly acquire: () => AsyncResult<R, AcquireError>

  /** Use the acquired resource. Release is attempted afterward. */
  readonly use: (resource: R) => AsyncResult<A, UseError>

  /** Release the resource, or omit it to use its disposal protocol. */
  readonly release?: (resource: R) => MaybePromise<ReleaseOutcome>

  /**
   * Observe cleanup failures without changing error precedence. This is most
   * useful when both `use` and `release` can fail.
   */
  readonly onReleaseFailure?: ReleaseFailureObserver
}
