import { AsyncLocalStorage } from 'node:async_hooks'

import { ServiceRuntimeNotConfiguredError } from './errors'

import type { AnyServiceToken } from './types'

/** Resolves class-backed Service tokens for a runtime execution. */
export interface ServiceResolver {
  /** Resolve a token to its corresponding Service instance. */
  resolve<T extends AnyServiceToken>(token: T): InstanceType<T> | PromiseLike<InstanceType<T>>
}

const storage = new AsyncLocalStorage<ServiceResolver>()

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
  static run<A>(resolver: ServiceResolver, program: () => A): A {
    return storage.run(resolver, program)
  }

  /** Return the resolver active in the current execution context. */
  static current(): ServiceResolver {
    const resolver = storage.getStore()

    if (!resolver) {
      throw new ServiceRuntimeNotConfiguredError()
    }

    return resolver
  }

  /** Resolve a Service token using the active resolver. */
  static async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    const resolver = ServiceRuntime.current()

    return await resolver.resolve(token)
  }
}
