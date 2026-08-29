import { createContainer } from 'iti'

import {
  DuplicateServiceError,
  ServiceTagCollisionError,
  type LayerBackend,
  type LayerBackendDisposeOptions,
  type LayerRegistration
} from '../layer'

import { ServiceNotFoundError, type AnyServiceToken } from '../service'
import { captureServiceTag } from '../service/tag'

import { assertServiceCompatibility } from '../layer/internal-identity'
import { captureLayerRegistrationTag, normalizeLayerRegistration } from '../layer/registration'
import { isPromiseLike } from '../utils/runtime'

type LayerAcquiredValue = Awaited<ReturnType<LayerRegistration['acquire']>>

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

  /**
   * Track async gets so disposal cannot reset ITI while a provider is acquiring.
   * ITI caches rejected acquisitions; replacing the container is the explicit
   * retry boundary for that sticky failure behavior.
   */
  private readonly pending = new Map<Promise<unknown>, AnyServiceToken>()

  private keyFor(tag: string): string {
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
    const normalized = normalizeLayerRegistration(registration)
    const token = normalized.service
    const tag = captureLayerRegistrationTag(normalized)
    const existing = this.registered.get(tag)

    if (existing === token) {
      throw new DuplicateServiceError(token)
    }

    if (existing) {
      throw new ServiceTagCollisionError(existing, token)
    }

    const key = this.keyFor(tag)

    this.container = this.container.add({
      [key]: normalized.acquire
    })

    this.registered.set(tag, token)
  }

  /** Resolve a registered Service through the ITI container. */
  resolve<T extends AnyServiceToken>(token: T): InstanceType<T> | PromiseLike<InstanceType<T>> {
    const tag = captureServiceTag(token)
    const registered = this.registered.get(tag)

    if (registered === undefined) {
      throw new ServiceNotFoundError(token)
    }

    const key = this.keyFor(tag)
    const resolved = this.container.get(key)

    const validate = (instance: LayerAcquiredValue): InstanceType<T> => {
      assertServiceCompatibility(token, registered, instance)

      // SAFETY: The registered tag and compatibility check establish the constructor-to-instance relationship after ITI erases it.
      return instance as InstanceType<T>
    }

    if (isPromiseLike(resolved)) {
      const pending = Promise.resolve(resolved).then(validate)

      this.pending.set(pending, registered)
      void pending.then(
        () => this.pending.delete(pending),
        () => this.pending.delete(pending)
      )

      return pending
    }

    return validate(resolved)
  }

  /** Reset container-owned ITI state; Scope owns Layer provider releases. */
  async disposeAll(options?: LayerBackendDisposeOptions): Promise<void> {
    const container = this.container
    const acquisitions = [...this.pending.keys()]

    try {
      if (acquisitions.length > 0) {
        const observePending = options?.onPendingAcquisitions

        if (observePending) {
          await observePending(acquisitions)
        }

        await Promise.allSettled(acquisitions)
      }
      await container.disposeAll()
    } finally {
      this.container = createContainer()
      this.registered.clear()
      this.keys.clear()
      this.pending.clear()
    }
  }
}
