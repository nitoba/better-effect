import type { Result as ResultType } from 'better-result'

export type MaybePromise<T> = T | PromiseLike<T>

export type AsyncResult<T, E> = MaybePromise<ResultType<T, E>>

export type ReleaseOutcome = void | ResultType<void, unknown>

export type DisposableResource = {
  [Symbol.dispose]?: () => void

  [Symbol.asyncDispose]?: () => MaybePromise<void>
}

export type AcquireUseReleaseOptions<R, A, AcquireError, UseError> = {
  /**
   * Nome utilizado para identificar o recurso
   * em eventuais erros de release.
   */
  readonly name: string

  /**
   * Adquire o recurso.
   */
  readonly acquire: () => AsyncResult<R, AcquireError>

  /**
   * Executa a operação usando o recurso.
   */
  readonly use: (resource: R) => AsyncResult<A, UseError>

  /**
   * Libera o recurso.
   *
   * Se não informado, Resource tentará usar:
   *
   * Symbol.asyncDispose
   * Symbol.dispose
   *
   * nessa ordem.
   */
  readonly release?: (resource: R) => MaybePromise<ReleaseOutcome>
}
