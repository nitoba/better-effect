import type { ServiceRequirement } from '../effect/types'
import type { AnyServiceToken, ServiceClass, ServiceRequirements } from '../service'
import type { ScopeOutcome } from '../scope'
import type { MaybePromise } from '../utils/types'

import { DuplicateServiceError } from './errors'

import { runLayerGenerator } from './internal'

import type { LayerGenerator, LayerGeneratorRequirements, LayerProvider, LayerSpec } from './types'

import type { AnyLayerSpec } from './types'

import type { OverrideLayerSpecs } from './inference'

declare const LayerTypeId: unique symbol

export class Layer<Specs extends AnyLayerSpec = AnyLayerSpec> {
  declare readonly [LayerTypeId]: Specs

  readonly providers: readonly LayerProvider[]

  private constructor(providers: readonly LayerProvider[]) {
    this.providers = Object.freeze([...providers])
  }

  static make<S extends ServiceClass<any>>(
    service: S,

    acquire: () => MaybePromise<InstanceType<S>>
  ): Layer<LayerSpec<S, ServiceRequirements<S>>> {
    return new Layer([
      {
        service,
        acquire
      }
    ])
  }

  static succeed<S extends ServiceClass<any>>(
    service: S,
    instance: InstanceType<S>
  ): Layer<LayerSpec<S, ServiceRequirements<S>>> {
    return Layer.make(service, () => instance)
  }

  static scoped<S extends ServiceClass<any>>(
    service: S,
    acquire: () => MaybePromise<InstanceType<S>>,
    release: (instance: InstanceType<S>) => MaybePromise<void>
  ): Layer<LayerSpec<S, ServiceRequirements<S>>> {
    return new Layer([
      {
        service,
        acquire,

        release: (instance) => release(instance as InstanceType<S>)
      }
    ])
  }

  static scopedGen<S extends ServiceClass<any>, Yield extends ServiceRequirement<AnyServiceToken>>(
    service: S,
    factory: LayerGenerator<S, Yield>,
    release: (instance: InstanceType<S>, outcome: ScopeOutcome) => MaybePromise<void>
  ): Layer<LayerSpec<S, LayerGeneratorRequirements<S, Yield>>> {
    return new Layer([
      {
        service,
        acquire: () => runLayerGenerator(service, factory),
        release: (instance, outcome) => release(instance as InstanceType<S>, outcome)
      }
    ])
  }

  static gen<S extends ServiceClass<any>, Yield extends ServiceRequirement<AnyServiceToken>>(
    service: S,
    factory: LayerGenerator<S, Yield>
  ): Layer<LayerSpec<S, LayerGeneratorRequirements<S, Yield>>> {
    return Layer.make(service, () => runLayerGenerator(service, factory))
  }

  static merge<const Layers extends readonly Layer<any>[]>(
    ...layers: Layers
  ): Layer<Layers[number] extends Layer<infer Specs> ? Specs : never> {
    const providers = new Map<ServiceClass<any>, LayerProvider>()

    for (const layer of layers) {
      for (const provider of layer.providers) {
        const service = provider.service

        if (providers.has(service)) {
          throw new DuplicateServiceError(service)
        }

        providers.set(service, provider)
      }
    }

    return new Layer([...providers.values()])
  }

  static override<Base extends Layer<any>, const Overrides extends readonly Layer<any>[]>(
    base: Base,
    ...overrides: Overrides
  ): Layer<OverrideLayerSpecs<Base extends Layer<infer Specs> ? Specs : never, Overrides>> {
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
