import type { ServiceClass } from '../service/types'

import type { LayerProvider, MaybePromise } from './types'

export class Layer {
  private constructor(readonly providers: readonly LayerProvider[]) {}

  static make<S extends ServiceClass<any>>(
    service: S,
    acquire: () => MaybePromise<InstanceType<S>>
  ): Layer {
    return new Layer([
      {
        service,
        acquire
      }
    ])
  }

  static succeed<S extends ServiceClass<any>>(service: S, instance: InstanceType<S>): Layer {
    return Layer.make(service, () => instance)
  }

  static scoped<S extends ServiceClass<any>>(
    service: S,
    acquire: () => MaybePromise<InstanceType<S>>,
    release: (instance: InstanceType<S>) => MaybePromise<void>
  ): Layer {
    return new Layer([
      {
        service,
        acquire,

        release: (instance) => release(instance as InstanceType<S>)
      }
    ])
  }

  static merge(...layers: readonly Layer[]): Layer {
    const providers = new Map<ServiceClass<any>, LayerProvider>()

    for (const layer of layers) {
      for (const provider of layer.providers) {
        const service = provider.service

        if (providers.has(service)) {
          throw new Error(`Duplicate service "${service.name}" in Layer.merge()`)
        }

        providers.set(service, provider)
      }
    }

    return new Layer([...providers.values()])
  }

  static override(base: Layer, ...overrides: readonly Layer[]): Layer {
    const providers = new Map<ServiceClass<any>, LayerProvider>()

    for (const provider of base.providers) {
      providers.set(provider.service, provider)
    }

    for (const layer of overrides) {
      for (const provider of layer.providers) {
        providers.set(provider.service, provider)
      }
    }

    return new Layer([...providers.values()])
  }
}
