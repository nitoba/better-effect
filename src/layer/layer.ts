import type { ServiceRequirement } from '../effect/types'
import type { AnyServiceToken, ServiceClass, ServiceRequirements } from '../service'
import type { ScopeOutcome } from '../scope'
import type { MaybePromise } from '../utils/types'

import { DuplicateServiceError, ServiceTagCollisionError } from './errors'

import { runLayerGenerator } from './internal'

import type {
  LayerGenerator,
  LayerGeneratorRequirements,
  LayerRegistration,
  LayerSpec
} from './types'

import type { AnyLayerSpec } from './types'

import type { OverrideLayerCollisions, OverrideLayerSpecs } from './inference'

declare const LayerTypeId: unique symbol
declare const LayerCollisionTypeId: unique symbol

interface LayerProvider extends LayerRegistration {
  readonly release?: (instance: unknown, outcome: ScopeOutcome) => MaybePromise<void>
}

export class Layer<
  Specs extends AnyLayerSpec = AnyLayerSpec,
  Collisions extends AnyServiceToken = never
> {
  declare readonly [LayerTypeId]: Specs
  declare readonly [LayerCollisionTypeId]: Collisions

  readonly providers: readonly LayerProvider[]

  private constructor(providers: readonly LayerProvider[]) {
    this.providers = Object.freeze([...providers])
  }

  static make<S extends ServiceClass<any, any>>(
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

  static succeed<S extends ServiceClass<any, any>>(
    service: S,
    instance: InstanceType<S>
  ): Layer<LayerSpec<S, ServiceRequirements<S>>> {
    return Layer.make(service, () => instance)
  }

  /**
   * Define a dependency-free provider with Runtime-root cleanup.
   *
   * The release callback intentionally keeps its compatibility-friendly
   * one-argument shape. Use `scopedGen` when cleanup needs `ScopeOutcome`.
   */
  static scoped<S extends ServiceClass<any, any>>(
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

  /** Define a contextual provider with Runtime-root, outcome-aware cleanup. */
  static scopedGen<
    S extends ServiceClass<any, any>,
    Yield extends ServiceRequirement<AnyServiceToken>
  >(
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

  static gen<S extends ServiceClass<any, any>, Yield extends ServiceRequirement<AnyServiceToken>>(
    service: S,
    factory: LayerGenerator<S, Yield>
  ): Layer<LayerSpec<S, LayerGeneratorRequirements<S, Yield>>> {
    return Layer.make(service, () => runLayerGenerator(service, factory))
  }

  static merge<const Layers extends readonly Layer<any, any>[]>(
    ...layers: Layers
  ): Layer<
    Layers[number] extends Layer<infer Specs, any> ? Specs : never,
    Layers[number] extends Layer<any, infer Collisions> ? Collisions : never
  > {
    const providers = new Map<string, LayerProvider>()

    for (const layer of layers) {
      for (const provider of layer.providers) {
        const service = provider.service

        const existing = providers.get(service.serviceTag)

        if (existing) {
          if (existing.service !== service) {
            throw new ServiceTagCollisionError(existing.service, service)
          }

          throw new DuplicateServiceError(service)
        }

        providers.set(service.serviceTag, provider)
      }
    }

    return new Layer([...providers.values()])
  }

  static override<Base extends Layer<any, any>, const Overrides extends readonly Layer<any, any>[]>(
    base: Base,
    ...overrides: Overrides
  ): Layer<
    OverrideLayerSpecs<Base extends Layer<infer Specs, any> ? Specs : never, Overrides>,
    | (Base extends Layer<any, infer Collisions> ? Collisions : never)
    | (Overrides[number] extends Layer<any, infer Collisions> ? Collisions : never)
    | OverrideLayerCollisions<Base extends Layer<infer Specs, any> ? Specs : never, Overrides>
  > {
    const providers = new Map<string, LayerProvider>()

    for (const provider of base.providers) {
      providers.set(provider.service.serviceTag, provider)
    }

    for (const layer of overrides) {
      for (const provider of layer.providers) {
        providers.set(provider.service.serviceTag, provider)
      }
    }

    return new Layer([...providers.values()]) as Layer<
      OverrideLayerSpecs<Base extends Layer<infer Specs, any> ? Specs : never, Overrides>,
      | (Base extends Layer<any, infer Collisions> ? Collisions : never)
      | (Overrides[number] extends Layer<any, infer Collisions> ? Collisions : never)
      | OverrideLayerCollisions<Base extends Layer<infer Specs, any> ? Specs : never, Overrides>
    >
  }
}
