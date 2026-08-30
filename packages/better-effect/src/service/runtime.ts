import { ServiceRuntimeNotConfiguredError } from './errors'
import { captureServiceTag } from './tag'

import { RuntimeContextNotConfiguredError } from '../runtime/errors'

import {
  currentRuntimeContext,
  getRuntimeContext,
  makeRuntimeContext,
  runRuntimeContext
} from '../runtime/context'

import { defaultRuntimeContextStorage } from '../runtime/default'

import type { AnyServiceToken } from './types'

import type { RuntimeContextStorage } from '../runtime/context'

/** Resolves class-backed Service tokens for a runtime execution. */
export interface ServiceResolver {
  /** Resolve a token to its corresponding Service instance. */
  resolve<T extends AnyServiceToken>(token: T): InstanceType<T> | PromiseLike<InstanceType<T>>
}

/** Provides the resolver context used by Service tokens during execution. */
export class ServiceRuntime {
  /**
   * Run a callback with a resolver available to `yield* Service` expressions.
   *
   * The context is scoped to the callback and is restored afterward.
   *
   * @example
   * ```ts
   * const value = ServiceRuntime.run(resolver, () => {
   *   return ServiceRuntime.resolve(Database)
   * })
   * ```
   */
  static run<A>(
    resolver: ServiceResolver,
    program: () => A,
    storage: RuntimeContextStorage = defaultRuntimeContextStorage
  ): A {
    const current = getRuntimeContext(storage)
    const context = makeRuntimeContext(
      resolver,
      current?.scope,
      current?.resolver === resolver ? current.resolutionPath : [],
      current?.signal,
      current?.resolver === resolver ? current : undefined,
      current?.executionId
    )

    return runRuntimeContext(storage, context, program)
  }

  /** Return the resolver active in the current execution context. */
  static current(): ServiceResolver {
    let context

    try {
      context = currentRuntimeContext()
    } catch (cause) {
      if (cause instanceof RuntimeContextNotConfiguredError) {
        throw new ServiceRuntimeNotConfiguredError()
      }

      throw cause
    }

    if (!context.resolver) {
      throw new ServiceRuntimeNotConfiguredError()
    }

    return context.resolver
  }

  /** Resolve a Service token using the active resolver. */
  static async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    captureServiceTag(token)
    const resolver = ServiceRuntime.current()

    return await resolver.resolve(token)
  }
}
