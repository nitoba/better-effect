import type { ServiceResolver } from '../service'
import type { MaybePromise } from '../utils/types'

import type { LayerRegistration } from './types'

export interface LayerBackend extends ServiceResolver {
  register(registration: LayerRegistration): MaybePromise<void>
  disposeAll(): MaybePromise<void>
}
