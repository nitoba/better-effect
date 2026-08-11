import type { Result as ResultType } from 'better-result'

export type { DisposableResource } from '../scope/types'

import type { ResourceReleaseFailure } from './errors'

export type MaybePromise<T> = T | PromiseLike<T>

export type AsyncResult<T, E> = MaybePromise<ResultType<T, E>>

export type ReleaseOutcome = void | ResultType<void, unknown>

export type ReleaseFailureObserver = (failure: ResourceReleaseFailure) => MaybePromise<void>

export type AcquireUseReleaseOptions<R, A, AcquireError, UseError> = {
  readonly name: string

  readonly acquire: () => AsyncResult<R, AcquireError>

  readonly use: (resource: R) => AsyncResult<A, UseError>

  readonly release?: (resource: R) => MaybePromise<ReleaseOutcome>

  /**
   * Observa falhas de cleanup sem
   * alterar a precedência de erros.
   *
   * Útil principalmente quando use
   * e release falham juntos.
   */
  readonly onReleaseFailure?: ReleaseFailureObserver
}
