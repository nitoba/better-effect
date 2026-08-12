import {
  DuplicateServiceError,
  ServiceTagCollisionError,
  type LayerBackend,
  type LayerRegistration
} from '../layer'

import { ServiceNotFoundError, type AnyServiceToken } from '../service'

import { assertServiceCompatibility } from '../layer/internal-identity'

export class MemoryLayerBackend implements LayerBackend {
  private readonly providers = new Map<string, LayerRegistration>()

  private readonly instances = new Map<string, unknown>()

  private readonly pending = new Map<string, Promise<unknown>>()

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

  async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    const tag = token.serviceTag
    const provider = this.providers.get(tag)

    if (!provider) {
      throw new ServiceNotFoundError(token)
    }

    const validate = (instance: unknown): InstanceType<T> => {
      assertServiceCompatibility(token, provider.service, instance)

      return instance as InstanceType<T>
    }

    if (this.instances.has(tag)) {
      return validate(this.instances.get(tag))
    }

    const pending = this.pending.get(tag)

    if (pending) {
      return validate(await pending)
    }

    const acquisition = Promise.resolve(provider.acquire())
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

  async disposeAll(): Promise<void> {
    if (this.pending.size > 0) {
      await Promise.allSettled(this.pending.values())
    }

    this.instances.clear()
    this.pending.clear()
    this.providers.clear()
  }
}
