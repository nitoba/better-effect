import { DuplicateServiceError, type LayerBackend, type LayerRegistration } from '../layer'

import { ServiceNotFoundError, type AnyServiceToken } from '../service'

export class MemoryLayerBackend implements LayerBackend {
  private readonly providers = new Map<AnyServiceToken, LayerRegistration>()

  private readonly instances = new Map<AnyServiceToken, unknown>()

  private readonly pending = new Map<AnyServiceToken, Promise<unknown>>()

  register(registration: LayerRegistration): void {
    if (this.providers.has(registration.service)) {
      throw new DuplicateServiceError(registration.service)
    }

    this.providers.set(registration.service, registration)
  }

  async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    if (this.instances.has(token)) {
      return this.instances.get(token) as InstanceType<T>
    }

    const pending = this.pending.get(token)

    if (pending) {
      return (await pending) as InstanceType<T>
    }

    const provider = this.providers.get(token)

    if (!provider) {
      throw new ServiceNotFoundError(token)
    }

    const acquisition = Promise.resolve(provider.acquire())
      .then((instance) => {
        this.instances.set(token, instance)

        return instance
      })
      .finally(() => {
        this.pending.delete(token)
      })

    this.pending.set(token, acquisition)

    return (await acquisition) as InstanceType<T>
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
