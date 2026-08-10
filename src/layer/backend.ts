import type { ServiceResolver } from '../service/runtime'

import type { LayerProvider } from './types'

export interface LayerBackend extends ServiceResolver {
  register(provider: LayerProvider): void | PromiseLike<void>

  disposeAll(): void | PromiseLike<void>
}
