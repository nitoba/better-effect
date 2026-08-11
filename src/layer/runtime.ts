import { ServiceRuntime } from '../service'

import { Scope } from '../scope'
import { ScopeRuntime } from '../scope/runtime'

import { BuiltLayerDisposedError, LayerDisposeError, LayerRegistrationError } from './errors'

import type { LayerBackend } from './backend'

import type { Layer } from './layer'

import type { LayerProvider } from './types'

export interface BuiltLayer {
  readonly backend: LayerBackend

  run<A>(program: () => A | PromiseLike<A>): Promise<Awaited<A>>

  dispose(): Promise<void>
}

const normalizeDisposeCauses = (cause: unknown): readonly unknown[] => {
  if (cause instanceof AggregateError) {
    return [...cause.errors]
  }

  return [cause]
}

const bindProviderToScope = (provider: LayerProvider, rootScope: Scope): LayerProvider => ({
  service: provider.service,

  acquire: () =>
    ScopeRuntime.run(rootScope, async () => {
      if (!provider.release) {
        return await provider.acquire()
      }

      return await rootScope.acquire(
        () => provider.acquire(),
        (resource) => provider.release!(resource)
      )
    })
})

class BuiltLayerImpl implements BuiltLayer {
  private disposePromise: Promise<void> | undefined

  private disposed = false

  constructor(
    readonly backend: LayerBackend,
    private readonly rootScope: Scope
  ) {}

  async run<A>(program: () => A | PromiseLike<A>): Promise<Awaited<A>> {
    if (this.disposed || this.disposePromise) {
      throw new BuiltLayerDisposedError()
    }

    return await ServiceRuntime.run(this.backend, () => Scope.run(() => program()))
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise
    }

    this.disposePromise = this.performDispose()

    return this.disposePromise
  }

  private async performDispose(): Promise<void> {
    const failures: unknown[] = []

    try {
      await ServiceRuntime.run(this.backend, () => this.rootScope.close())
    } catch (cause) {
      failures.push(cause)
    }

    try {
      await this.backend.disposeAll()
    } catch (cause) {
      failures.push(cause)
    }

    this.disposed = true

    if (failures.length > 0) {
      throw new LayerDisposeError(failures.flatMap(normalizeDisposeCauses))
    }
  }
}

export const buildLayer = async (layer: Layer<any>, backend: LayerBackend): Promise<BuiltLayer> => {
  const rootScope = Scope.make()
  let current: LayerProvider | undefined

  try {
    for (const provider of layer.providers) {
      current = provider

      await backend.register(bindProviderToScope(provider, rootScope))
    }
  } catch (registrationCause) {
    const cleanupCauses: unknown[] = []

    try {
      await rootScope.close()
    } catch (cause) {
      cleanupCauses.push(cause)
    }

    try {
      await backend.disposeAll()
    } catch (cause) {
      cleanupCauses.push(cause)
    }

    let cleanupCause: unknown

    if (cleanupCauses.length === 1) {
      cleanupCause = cleanupCauses[0]
    } else if (cleanupCauses.length > 1) {
      cleanupCause = new AggregateError(cleanupCauses, 'Layer registration cleanup failed')
    }

    throw new LayerRegistrationError(current?.service, registrationCause, cleanupCause)
  }

  return new BuiltLayerImpl(backend, rootScope)
}
