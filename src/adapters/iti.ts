import { createContainer } from 'iti'

import {
  DuplicateServiceError,
  ServiceTagCollisionError,
  type LayerBackend,
  type LayerRegistration
} from '../layer'

import { ServiceNotFoundError, type AnyServiceToken } from '../service'

import { assertServiceCompatibility } from '../layer/internal-identity'

/**
 * ITI-backed Layer backend.
 *
 * Install `iti` as the optional peer dependency and pass an instance to
 * `Runtime.make` when using ITI's container implementation.
 */
export class ItiLayerBackend implements LayerBackend {
  private container: any = createContainer()

  private readonly keys = new Map<string, string>()

  private readonly registered = new Map<string, AnyServiceToken>()

  private keyFor(token: AnyServiceToken): string {
    const tag = token.serviceTag
    const existing = this.keys.get(tag)

    if (existing) {
      return existing
    }

    const key = `better-effect:${tag}`

    this.keys.set(tag, key)

    return key
  }

  /** Register a Layer provider under its deterministic Service-tag key. */
  register(registration: LayerRegistration): void {
    const token = registration.service
    const tag = token.serviceTag
    const existing = this.registered.get(tag)

    if (existing === token) {
      throw new DuplicateServiceError(token)
    }

    if (existing) {
      throw new ServiceTagCollisionError(existing, token)
    }

    const key = this.keyFor(token)

    this.container = this.container.add({
      [key]: registration.acquire
    })

    this.registered.set(tag, token)
  }

  /** Resolve a registered Service through the ITI container. */
  resolve<T extends AnyServiceToken>(token: T): InstanceType<T> | PromiseLike<InstanceType<T>> {
    if (!this.registered.has(token.serviceTag)) {
      throw new ServiceNotFoundError(token)
    }

    const registered = this.registered.get(token.serviceTag)
    const key = this.keyFor(token)
    const resolved = this.container.get(key) as unknown

    const validate = (instance: unknown): InstanceType<T> => {
      assertServiceCompatibility(token, registered!, instance)

      return instance as InstanceType<T>
    }

    if (resolved && typeof (resolved as PromiseLike<unknown>).then === 'function') {
      return Promise.resolve(resolved).then(validate)
    }

    return validate(resolved)
  }

  /** Dispose all ITI-managed provider instances. */
  async disposeAll(): Promise<void> {
    await this.container.disposeAll()
  }
}
