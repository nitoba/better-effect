import { AsyncLocalStorage } from 'node:async_hooks'

import {
  CircularDependencyError,
  ServiceAcquisitionError,
  ServiceNotFoundError,
  type AnyServiceToken,
  type ServiceResolver
} from '../service'

import { ServiceTagCollisionError } from './errors'

type ResolutionContext = {
  readonly resolver: ServiceResolver
  readonly path: readonly AnyServiceToken[]
}

const resolutionStorage = new AsyncLocalStorage<ResolutionContext>()

const findCycleStart = (path: readonly AnyServiceToken[], token: AnyServiceToken): number =>
  path.findIndex((current) => current.serviceTag === token.serviceTag)

const shouldPreserve = (cause: unknown): boolean =>
  cause instanceof CircularDependencyError ||
  cause instanceof ServiceAcquisitionError ||
  cause instanceof ServiceNotFoundError ||
  cause instanceof ServiceTagCollisionError

/** Wrap a backend with Runtime-local resolution paths and acquisition errors. */
export const createResolutionResolver = (resolver: ServiceResolver): ServiceResolver => {
  const wrapped: ServiceResolver = {
    async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
      const context = resolutionStorage.getStore()
      const path = context?.resolver === wrapped ? context.path : []
      const cycleStart = findCycleStart(path, token)

      if (cycleStart >= 0) {
        throw new CircularDependencyError([...path.slice(cycleStart), token])
      }

      const resolutionPath = [...path, token]

      return await resolutionStorage.run({ resolver: wrapped, path: resolutionPath }, async () => {
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
