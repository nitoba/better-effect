import { createContainer } from 'iti'

import type { LayerBackend } from '../layer'

import type { AnyServiceToken, ServiceToken } from '../service'
import type { LayerProvider } from '../layer/types'

export class ItiLayerBackend implements LayerBackend {
  private container: any = createContainer()

  private readonly keys = new WeakMap<ServiceToken<any>, string>()

  private nextId = 0

  private keyFor(token: AnyServiceToken): string {
    const existing = this.keys.get(token)

    if (existing) {
      return existing
    }

    const name = (token as Function).name || 'Service'

    const key = `better-effect:${name}:${this.nextId++}`

    this.keys.set(token, key)

    return key
  }

  register(provider: LayerProvider): void {
    const key = this.keyFor(provider.service)

    this.container = this.container.add({
      [key]: provider.acquire
    })

    if (provider.release) {
      this.container = this.container.addDisposer({
        [key]: provider.release
      })
    }
  }

  resolve<T extends AnyServiceToken>(token: T): InstanceType<T> | PromiseLike<InstanceType<T>> {
    const key = this.keyFor(token)

    return this.container.get(key) as InstanceType<T> | PromiseLike<InstanceType<T>>
  }

  async disposeAll(): Promise<void> {
    await this.container.disposeAll()
  }
}
