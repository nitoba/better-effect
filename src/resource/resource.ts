import { Result, type Result as ResultType, type UnhandledException } from 'better-result'

import { ResourceReleaseFailure } from './errors'

import { combineUseAndRelease, disposeResource, runRelease, runResult } from './internal'

import type { AcquireUseReleaseOptions } from './types'

const acquireUseRelease = <R, A, AcquireError, UseError>({
  name,
  acquire,
  use,
  release = disposeResource
}: AcquireUseReleaseOptions<R, A, AcquireError, UseError>): Promise<
  ResultType<A, AcquireError | UseError | UnhandledException | ResourceReleaseFailure>
> =>
  Result.gen(async function* () {
    const resource = yield* Result.await(runResult(acquire))

    /**
     * Não usamos yield* aqui.
     *
     * Se use retornar Err, o generator seria
     * encerrado imediatamente e o release
     * nunca seria executado.
     */
    const used = await runResult(() => use(resource))

    const released = await runRelease(name, resource, release)

    return combineUseAndRelease(used, released)
  })

export const Resource = {
  acquireUseRelease
} as const
