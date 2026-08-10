import { DuplicateServiceError, type LayerBackend, type LayerProvider } from '../layer'

import { ServiceNotFoundError, type AnyServiceToken } from '../service'

export class MemoryLayerBackend implements LayerBackend {
  private readonly providers = new Map<AnyServiceToken, LayerProvider>()

  private readonly instances = new Map<AnyServiceToken, unknown>()

  private readonly pending = new Map<AnyServiceToken, Promise<unknown>>()

  private readonly resolutionOrder: AnyServiceToken[] = []

  register(provider: LayerProvider): void {
    if (this.providers.has(provider.service)) {
      throw new DuplicateServiceError(provider.service)
    }

    this.providers.set(provider.service, provider)
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

        this.resolutionOrder.push(token)

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

    const errors: unknown[] = []

    for (let index = this.resolutionOrder.length - 1; index >= 0; index--) {
      const token = this.resolutionOrder[index]

      if (!token) {
        continue
      }

      const instance = this.instances.get(token)

      const provider = this.providers.get(token)

      if (instance === undefined || !provider?.release) {
        continue
      }

      try {
        await provider.release(instance)
      } catch (cause) {
        errors.push(cause)
      }
    }

    this.instances.clear()
    this.pending.clear()

    this.resolutionOrder.splice(0)

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to dispose one or more services')
    }
  }
}
