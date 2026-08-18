import { assertServiceCompatibility } from './internal-identity'

import { DuplicateServiceError, ServiceTagCollisionError } from './errors'

import type { LayerBackend } from './backend'
import type { LayerRegistration } from './types'

import { ServiceNotFoundError, type AnyServiceToken } from '../service'

type LayerAcquiredValue = Awaited<ReturnType<LayerRegistration['acquire']>>

/** Native map-backed Layer backend used by Runtime when no adapter is supplied. */
export class MapLayerBackend implements LayerBackend {
  private readonly providers = new Map<string, LayerRegistration>()

  private readonly instances = new Map<string, LayerAcquiredValue>()

  private readonly pending = new Map<string, Promise<LayerAcquiredValue>>()

  /** Register a provider, rejecting duplicate or colliding Service tags. */
  register(registration: LayerRegistration): void {
    const tag = registration.service.serviceTag
    const existing = this.providers.get(tag)

    if (existing) {
      if (existing.service !== registration.service) {
        throw new ServiceTagCollisionError(existing.service, registration.service)
      }

      throw new DuplicateServiceError(registration.service)
    }

    this.providers.set(tag, registration)
  }

  /** Resolve and cache a provider instance by Service tag. */
  async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    const tag = token.serviceTag
    const provider = this.providers.get(tag)

    if (!provider) {
      throw new ServiceNotFoundError(token)
    }

    const validate = (instance: LayerAcquiredValue): InstanceType<T> => {
      assertServiceCompatibility(token, provider.service, instance)

      // SAFETY: The provider and requested token share a tag, and compatibility checks verify the registered members before restoring the token-specific instance type.
      return instance as InstanceType<T>
    }

    const cached = this.instances.get(tag)

    if (cached !== undefined) {
      return validate(cached)
    }

    const pending = this.pending.get(tag)

    if (pending) {
      return validate(await pending)
    }

    const acquisition = Promise.resolve()
      .then(() => provider.acquire())
      .then((instance) => {
        validate(instance)
        this.instances.set(tag, instance)

        return instance
      })
      .finally(() => {
        this.pending.delete(tag)
      })

    this.pending.set(tag, acquisition)

    return validate(await acquisition)
  }

  /** Clear pending acquisitions, cached instances, and provider registrations. */
  async disposeAll(): Promise<void> {
    if (this.pending.size > 0) {
      await Promise.allSettled(this.pending.values())
    }

    this.instances.clear()
    this.pending.clear()
    this.providers.clear()
  }
}
