import type { ServiceResolver } from '../service'

import type { LayerProvider } from './types'

export interface LayerBackend extends ServiceResolver {
  register(provider: LayerProvider): void | PromiseLike<void>
  disposeAll(): void | PromiseLike<void>
}
