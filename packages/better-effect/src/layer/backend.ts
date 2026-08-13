import type { ServiceResolver } from '../service'
import type { MaybePromise } from '../utils/types'

import type { LayerRegistration } from './types'

/** Runtime adapter responsible for registering, resolving, and disposing Layer providers. */
export interface LayerBackend extends ServiceResolver {
  /** Register one Service provider with the backend. */
  register(registration: LayerRegistration): MaybePromise<void>

  /** Dispose all backend-owned instances and provider registrations. */
  disposeAll(): MaybePromise<void>
}
