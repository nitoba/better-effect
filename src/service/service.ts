import { ServiceRuntime } from './runtime'

import type { ServiceRequirement } from '../effect/types'

import type { ServiceToken } from './types'

export function Service<Self>() {
  return class {
    // oxlint-disable-next-line require-yield
    static async *[Symbol.asyncIterator](
      this: ServiceToken<Self>
    ): AsyncGenerator<ServiceRequirement<ServiceToken<Self>>, Self, unknown> {
      return await ServiceRuntime.resolve(this)
    }
  }
}
