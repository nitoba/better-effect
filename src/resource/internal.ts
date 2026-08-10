import { Result, type Result as ResultType, type UnhandledException } from 'better-result'

import { ResourceReleaseFailure } from './errors'

import type { AsyncResult, DisposableResource, MaybePromise, ReleaseOutcome } from './types'

export const disposeResource = (resource: unknown): MaybePromise<void> => {
  const candidate = Object(resource) as DisposableResource

  const dispose = candidate[Symbol.asyncDispose] ?? candidate[Symbol.dispose]

  return dispose?.call(candidate)
}

const toReleaseFailure = (resource: string, cause: unknown): ResourceReleaseFailure =>
  new ResourceReleaseFailure({
    resource,
    cause,
    message: `Failed to release resource: ${resource}`
  })

/**
 * Executa uma operação que retorna Result e converte
 * exceptions/rejections inesperadas para UnhandledException.
 */
export const runResult = async <T, E>(
  operation: () => AsyncResult<T, E>
): Promise<ResultType<T, E | UnhandledException>> => {
  const execution = await Result.tryPromise(() => Promise.resolve(operation()))

  return execution.andThen((result) => result)
}

const normalizeReleaseOutcome = (
  name: string,
  outcome: ReleaseOutcome
): ResultType<void, ResourceReleaseFailure> => {
  if (outcome === undefined) {
    return Result.ok()
  }

  return outcome.mapError((cause) => toReleaseFailure(name, cause))
}

export const runRelease = async <R>(
  name: string,
  resource: R,
  release: (resource: R) => MaybePromise<ReleaseOutcome>
): Promise<ResultType<void, ResourceReleaseFailure>> => {
  const execution = await Result.tryPromise({
    try: () => Promise.resolve(release(resource)),

    catch: (cause) => toReleaseFailure(name, cause)
  })

  return execution.andThen((outcome) => normalizeReleaseOutcome(name, outcome))
}

/**
 * Precedência:
 *
 * 1. erro ocorrido durante use
 * 2. erro ocorrido durante release
 * 3. valor produzido por use
 */
export const combineUseAndRelease = <A, E>(
  used: ResultType<A, E>,
  released: ResultType<void, ResourceReleaseFailure>
): ResultType<A, E | ResourceReleaseFailure> => used.andThen((value) => released.map(() => value))
