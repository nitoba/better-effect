import { Result, type Result as ResultType, type UnhandledException } from 'better-result'

import { ResourceReleaseFailure } from './errors'

import type {
  AsyncResult,
  DisposableResource,
  MaybePromise,
  ReleaseFailureObserver,
  ReleaseOutcome
} from './types'

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

const notifyReleaseFailure = async (
  observer: ReleaseFailureObserver | undefined,

  failure: ResourceReleaseFailure
): Promise<void> => {
  if (!observer) {
    return
  }

  try {
    await observer(failure)
  } catch {
    /*
     * Diagnostics must never replace
     * the actual operation error.
     */
  }
}

export const combineUseAndRelease = async <A, E>(
  used: ResultType<A, E>,

  released: ResultType<void, ResourceReleaseFailure>,

  onReleaseFailure?: ReleaseFailureObserver
): Promise<ResultType<A, E | ResourceReleaseFailure>> => {
  if (Result.isError(used)) {
    if (Result.isError(released)) {
      await notifyReleaseFailure(onReleaseFailure, released.error)
    }

    return Result.err<A, E | ResourceReleaseFailure>(used.error)
  }

  if (Result.isError(released)) {
    await notifyReleaseFailure(onReleaseFailure, released.error)

    return Result.err<A, E | ResourceReleaseFailure>(released.error)
  }

  return Result.ok<A, E | ResourceReleaseFailure>(used.value)
}
