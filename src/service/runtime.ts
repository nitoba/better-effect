import { AsyncLocalStorage } from 'node:async_hooks'

import { ServiceRuntimeNotConfiguredError } from './errors'

import type { AnyServiceToken } from './types'

export interface ServiceResolver {
  resolve<T extends AnyServiceToken>(token: T): InstanceType<T> | PromiseLike<InstanceType<T>>
}

const storage = new AsyncLocalStorage<ServiceResolver>()

export class ServiceRuntime {
  static run<A>(resolver: ServiceResolver, program: () => A): A {
    return storage.run(resolver, program)
  }

  static current(): ServiceResolver {
    const resolver = storage.getStore()

    if (!resolver) {
      throw new ServiceRuntimeNotConfiguredError()
    }

    return resolver
  }

  static async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    const resolver = ServiceRuntime.current()

    return await resolver.resolve(token)
  }
}
