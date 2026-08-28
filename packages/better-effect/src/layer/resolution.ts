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

import { notifyRuntimeObservers, type RuntimeObserver } from '../runtime/observer'

import type { ScopeOutcome } from '../scope'

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
  storage: RuntimeContextStorage = defaultRuntimeContextStorage,
  observers: readonly RuntimeObserver[] = []
): ServiceResolver => {
  const wrapped: ServiceResolver = {
    async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
      const context = getRuntimeContext(storage)
      const path = context?.resolutionPath ?? []
      const cycleStart = findCycleStart(path, token)
      const resolutionPath = [...path, token]

      const notifyResolve = (outcome: ScopeOutcome): void => {
        notifyRuntimeObservers(observers, (observer) => observer.onServiceResolve, {
          service: token,
          resolutionPath,
          outcome
        })
      }

      if (cycleStart >= 0) {
        const error = new CircularDependencyError([...path.slice(cycleStart), token])
        notifyResolve({ status: 'failure', cause: error })
        throw error
      }

      const nextContext = makeRuntimeContext(
        wrapped,
        context?.scope,
        resolutionPath,
        context?.signal,
        context
      )

      return await runRuntimeContext(storage, nextContext, async () => {
        try {
          const instance = await resolver.resolve(token)
          notifyResolve({ status: 'success' })
          return instance
        } catch (cause) {
          if (shouldPreserve(cause)) {
            notifyResolve({ status: 'failure', cause })
            throw cause
          }

          const error = new ServiceAcquisitionError(token, resolutionPath, cause)
          notifyResolve({ status: 'failure', cause: error })
          throw error
        }
      })
    }
  }

  return wrapped
}
