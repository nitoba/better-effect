import type { AnyServiceToken, ServiceResolver } from '../service'
import type { MaybePromise } from '../utils/types'

import type { LayerRegistration } from './types'

/** Observation hook invoked for acquisitions that disposal will await. */
export type LayerBackendDisposeOptions = {
  /**
   * Receives the registered tokens with acquisitions pending when disposal begins.
   * The callback is invoked synchronously before the backend awaits or clears them.
   */
  readonly onPendingAcquisitions?: (services: readonly AnyServiceToken[]) => void
}

/** Runtime adapter responsible for registering, resolving, and disposing Layer providers. */
export interface LayerBackend extends ServiceResolver {
  /** Register one Service provider with the backend. */
  register(registration: LayerRegistration): MaybePromise<void>

  /** Dispose all backend-owned instances and provider registrations. */
  disposeAll(options?: LayerBackendDisposeOptions): MaybePromise<void>
}
