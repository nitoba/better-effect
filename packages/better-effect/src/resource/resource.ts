import { Result, type Result as ResultType, type UnhandledException } from 'better-result'

import { Scope } from '../scope'

import { ResourceReleaseFailure } from './errors'

import { combineUseAndRelease, disposeResource, runRelease, runResult } from './internal'

import type { AcquireUseReleaseOptions } from './types'

/**
 * Acquire a resource, use it, and always attempt release afterward.
 *
 * Acquisition, use, and release may be synchronous or asynchronous Result
 * operations. If both use and release fail, the use error remains primary and
 * `onReleaseFailure` receives the cleanup failure as a diagnostic.
 *
 * When `release` is omitted, `Symbol.asyncDispose` is preferred over
 * `Symbol.dispose`.
 *
 * @example
 * ```ts
 * const result = await Resource.acquireUseRelease({
 *   name: 'database connection',
 *   acquire: () => connect(),
 *   use: (connection) => query(connection),
 *   release: (connection) => connection.close()
 * })
 * ```
 */
const acquireUseRelease = <R, A, AcquireError, UseError>({
  name,
  acquire,
  use,
  release = disposeResource,
  onReleaseFailure
}: AcquireUseReleaseOptions<R, A, AcquireError, UseError>): Promise<
  ResultType<A, AcquireError | UseError | UnhandledException | ResourceReleaseFailure>
> =>
  Result.gen(async function* () {
    const resource = yield* Result.await(runResult(acquire))

    const scope = Scope.make()

    let released: ResultType<void, ResourceReleaseFailure> = Result.ok()

    scope.addFinalizer(async () => {
      released = await runRelease(name, resource, release)
    })

    const used = await runResult(() => use(resource))

    await scope.close()

    return await combineUseAndRelease(used, released, onReleaseFailure)
  })

export const Resource = {
  /** Acquire, use, and release a resource with deterministic error precedence. */
  acquireUseRelease
} as const
