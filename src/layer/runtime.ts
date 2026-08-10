import { ServiceRuntime } from '../service'

import { BuiltLayerDisposedError, LayerDisposeError, LayerRegistrationError } from './errors'

import type { LayerBackend } from './backend'

import type { Layer } from './layer'

import type { LayerProvider } from './types'

export interface BuiltLayer {
  readonly backend: LayerBackend

  run<A>(program: () => A): A

  dispose(): Promise<void>
}

const normalizeDisposeCauses = (cause: unknown): readonly unknown[] => {
  if (cause instanceof AggregateError) {
    return [...cause.errors]
  }

  return [cause]
}

class BuiltLayerImpl implements BuiltLayer {
  private disposePromise: Promise<void> | undefined

  private disposed = false

  constructor(readonly backend: LayerBackend) {}

  run<A>(program: () => A): A {
    if (this.disposed || this.disposePromise) {
      throw new BuiltLayerDisposedError()
    }

    return ServiceRuntime.run(this.backend, program)
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise
    }

    this.disposePromise = this.performDispose()

    return this.disposePromise
  }

  private async performDispose(): Promise<void> {
    try {
      await this.backend.disposeAll()
    } catch (cause) {
      throw new LayerDisposeError(normalizeDisposeCauses(cause))
    } finally {
      this.disposed = true
    }
  }
}

export const buildLayer = async (layer: Layer<any>, backend: LayerBackend): Promise<BuiltLayer> => {
  let current: LayerProvider | undefined

  try {
    for (const provider of layer.providers) {
      current = provider

      await backend.register(provider)
    }
  } catch (registrationCause) {
    let cleanupCause: unknown

    try {
      await backend.disposeAll()
    } catch (cause) {
      cleanupCause = cause
    }

    throw new LayerRegistrationError(current?.service, registrationCause, cleanupCause)
  }

  return new BuiltLayerImpl(backend)
}
