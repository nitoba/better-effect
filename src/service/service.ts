import { ServiceRuntime } from './runtime'

import type { ServiceToken } from './types'

export function Service<Self>() {
  return class {
    // oxlint-disable-next-line require-yield
    static async *[Symbol.asyncIterator](): AsyncGenerator<never, Self, unknown> {
      return await ServiceRuntime.resolve(this as unknown as ServiceToken<Self>)
    }
  }
}
