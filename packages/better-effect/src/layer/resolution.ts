import {
  CircularDependencyError,
  ServiceAcquisitionError,
  ServiceNotFoundError,
  type AnyServiceToken,
  type ServiceResolver
} from '../service'

import { getRuntimeContext, makeRuntimeContext, runRuntimeContext } from '../runtime/context'

import { defaultRuntimeContextStorage } from '../runtime/default'

import type { RuntimeContextStorage } from '../runtime/context'

import { ServiceTagCollisionError } from './errors'

const findCycleStart = (path: readonly AnyServiceToken[], token: AnyServiceToken): number =>
  path.findIndex((current) => current.serviceTag === token.serviceTag)

const shouldPreserve = (cause: unknown): boolean =>
  cause instanceof CircularDependencyError ||
  cause instanceof ServiceAcquisitionError ||
  cause instanceof ServiceNotFoundError ||
  cause instanceof ServiceTagCollisionError

/** Wrap a backend with Runtime-local resolution paths and acquisition errors. */
export const createResolutionResolver = (
  resolver: ServiceResolver,
  storage: RuntimeContextStorage = defaultRuntimeContextStorage
): ServiceResolver => {
  const wrapped: ServiceResolver = {
    async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
      const context = getRuntimeContext(storage)
      const path = context?.resolutionPath ?? []
      const cycleStart = findCycleStart(path, token)

      if (cycleStart >= 0) {
        throw new CircularDependencyError([...path.slice(cycleStart), token])
      }

      const resolutionPath = [...path, token]

      const nextContext = makeRuntimeContext(
        wrapped,
        context?.scope,
        resolutionPath,
        context?.signal
      )

      return await runRuntimeContext(storage, nextContext, async () => {
        try {
          return await resolver.resolve(token)
        } catch (cause) {
          if (shouldPreserve(cause)) {
            throw cause
          }

          throw new ServiceAcquisitionError(token, resolutionPath, cause)
        }
      })
    }
  }

  return wrapped
}
