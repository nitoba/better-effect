import { createContainer } from 'iti'

import { DuplicateServiceError, type LayerBackend, type LayerRegistration } from '../layer'

import { ServiceNotFoundError, type AnyServiceToken } from '../service'

export class ItiLayerBackend implements LayerBackend {
  private container: any = createContainer()

  private readonly keys = new WeakMap<AnyServiceToken, string>()

  private readonly registered = new WeakSet<AnyServiceToken>()

  private nextId = 0

  private keyFor(token: AnyServiceToken): string {
    const existing = this.keys.get(token)

    if (existing) {
      return existing
    }

    const name = token.name || 'Service'

    const key = `better-effect:${name}:${this.nextId++}`

    this.keys.set(token, key)

    return key
  }

  register(registration: LayerRegistration): void {
    const token = registration.service

    if (this.registered.has(token)) {
      throw new DuplicateServiceError(token)
    }

    const key = this.keyFor(token)

    this.container = this.container.add({
      [key]: registration.acquire
    })

    this.registered.add(token)
  }

  resolve<T extends AnyServiceToken>(token: T): InstanceType<T> | PromiseLike<InstanceType<T>> {
    if (!this.registered.has(token)) {
      throw new ServiceNotFoundError(token)
    }

    const key = this.keyFor(token)

    return this.container.get(key) as InstanceType<T> | PromiseLike<InstanceType<T>>
  }

  async disposeAll(): Promise<void> {
    await this.container.disposeAll()
  }
}
