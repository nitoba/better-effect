import type { AnyServiceToken } from './types'

export interface ServiceResolver {
  resolve<T extends AnyServiceToken>(token: T): InstanceType<T> | PromiseLike<InstanceType<T>>
}

let currentResolver: ServiceResolver | undefined

export class ServiceRuntime {
  static configure(resolver: ServiceResolver): void {
    currentResolver = resolver
  }

  static async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    if (!currentResolver) {
      throw new Error('ServiceRuntime has not been configured')
    }

    return await currentResolver.resolve(token)
  }

  static reset(): void {
    currentResolver = undefined
  }
}
