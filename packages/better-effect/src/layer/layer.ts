import type { ServiceRequirement } from '../effect/types'
import type { AnyService, ServiceClass, ServiceContract, ServiceRequirements } from '../service'
import type { ScopeOutcome } from '../scope'
import type { Covariant, Invariant } from '../internal/variance'
import type { MaybePromise } from '../utils/types'

import { DuplicateServiceError, ServiceTagCollisionError } from './errors'
import { runLayerGenerator } from './internal'

import type {
  LayerInput,
  CompleteInput,
  LayerResult,
  MergeResult,
  OverrideLayerResult,
  ValidateLayerInput,
  ValidateLayerTuple,
  ValidateOverrides,
  ProvidedEnvironment,
  RequiredEnvironment
} from './inference'
import type { ProviderEntry } from './metadata'
import type { LayerGenerator, LayerGeneratorRequirements, LayerRegistration } from './types'

declare const LayerTypeId: unique symbol

interface LayerVariance<in out Provided, out Required> {
  readonly _Provided: Invariant<Provided>
  readonly _Required: Covariant<Required>
}

interface LayerProvider extends LayerRegistration {
  /** Provider storage deliberately erases the concrete instance type. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  readonly release?: (instance: unknown, outcome: ScopeOutcome) => MaybePromise<void>
}

/** A Service class whose constructor can be called without arguments. */
type DefaultConstructibleServiceClass<
  Tag extends string = string,
  Instance extends AnyService = AnyService
> = ServiceClass<Tag, Instance> & (new () => Instance)

/**
 * Declarative collection of Service providers.
 *
 * A Layer describes how to acquire implementations; it does not execute
 * providers until a `Runtime` is created. Use `merge` to compose distinct
 * providers and `override` when replacing an existing provider intentionally.
 *
 * @example
 * ```ts
 * const AppLive = Layer.merge(
 *   Layer.succeed(Database, database),
 *   Layer.make(UserRepository)
 * )
 *
 * const runtime = await Runtime.make(AppLive, backend)
 * ```
 */
export class Layer<
  in out Provided extends AnyService = AnyService,
  out Required extends AnyService = AnyService
> {
  declare readonly [LayerTypeId]: LayerVariance<Provided, Required>

  /** The provider registrations retained by this Layer. */
  readonly providers: readonly LayerProvider[]

  private constructor(providers: readonly LayerProvider[]) {
    this.providers = Object.freeze([...providers])
  }

  /** Create a Layer that lazily acquires a Service instance. */
  static make<S extends DefaultConstructibleServiceClass<any, any>>(
    service: S
  ): LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>>

  static make<S extends ServiceClass<any, any>>(
    service: S,
    acquire: () => MaybePromise<ServiceContract<InstanceType<S>>>
  ): LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>>

  static make<S extends ServiceClass<any, any>>(
    service: S,
    acquire?: () => MaybePromise<ServiceContract<InstanceType<S>>>
  ): LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>> {
    const defaultAcquire = (): InstanceType<S> => {
      // SAFETY: The no-argument overload constrains `service` to a default constructible class.
      const Constructor = service as new () => InstanceType<S>

      return new Constructor()
    }

    const normalizedAcquire = normalizeAcquire<S>(acquire ?? defaultAcquire)

    // SAFETY: Runtime storage erases only the concrete provider metadata; the public constructor result restores its typed provenance.
    return new Layer([
      {
        service,
        acquire: normalizedAcquire
      }
    ]) as LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>>
  }

  /** Create a Layer from an already-constructed Service instance. */
  static succeed<S extends ServiceClass<any, any>>(
    service: S,
    instance: ServiceContract<InstanceType<S>>
  ): LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>> {
    const normalizedAcquire = normalizeAcquire<S>(() => instance)

    // SAFETY: The structural instance has been checked against the requested Service contract.
    return new Layer([
      {
        service,
        acquire: normalizedAcquire
      }
    ]) as LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>>
  }

  /** Define a provider with Runtime-root cleanup. */
  static scoped<S extends ServiceClass<any, any>>(
    service: S,
    acquire: () => MaybePromise<ServiceContract<InstanceType<S>>>,
    release: (instance: InstanceType<S>, outcome: ScopeOutcome) => MaybePromise<void>
  ): LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>> {
    // SAFETY: The public callbacks constrain acquisition and release to the requested Service.
    return new Layer([
      {
        service,
        acquire: normalizeAcquire<S>(acquire),
        release: (instance, outcome) => {
          // SAFETY: The backend invokes release with the instance acquired for this token.
          return release(instance as InstanceType<S>, outcome)
        }
      }
    ]) as LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>>
  }

  /** Define a provider whose acquisition can yield contextual Services. */
  static scopedGen<S extends ServiceClass<any, any>, Yield extends ServiceRequirement<unknown>>(
    service: S,
    factory: LayerGenerator<S, Yield>,
    release: (instance: InstanceType<S>, outcome: ScopeOutcome) => MaybePromise<void>
  ): LayerResult<ProviderEntry<InstanceType<S>, LayerGeneratorRequirements<S, Yield>>> {
    // SAFETY: The generator and release callback are checked against the requested Service.
    return new Layer([
      {
        service,
        acquire: () => runLayerGenerator(service, factory),
        release: (instance, outcome) => {
          // SAFETY: The backend invokes release with the instance acquired for this token.
          return release(instance as InstanceType<S>, outcome)
        }
      }
    ]) as LayerResult<ProviderEntry<InstanceType<S>, LayerGeneratorRequirements<S, Yield>>>
  }

  /** Define a provider whose acquisition can yield contextual Services. */
  static gen<S extends ServiceClass<any, any>, Yield extends ServiceRequirement<unknown>>(
    service: S,
    factory: LayerGenerator<S, Yield>
  ): LayerResult<ProviderEntry<InstanceType<S>, LayerGeneratorRequirements<S, Yield>>> {
    // SAFETY: The generator result is normalized to the requested Service at the runtime boundary.
    return new Layer([
      {
        service,
        acquire: () => runLayerGenerator(service, factory)
      }
    ]) as LayerResult<ProviderEntry<InstanceType<S>, LayerGeneratorRequirements<S, Yield>>>
  }

  /** Compose Layers without replacing providers. */
  static merge<const Layers extends readonly LayerInput[]>(
    ...layers: Layers & ValidateLayerTuple<Layers>
  ): MergeResult<Layers> {
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

    // SAFETY: The heterogeneous provider list is erased only at this internal storage boundary.
    return new Layer([...providers.values()]) as MergeResult<Layers>
  }

  /** Mark a Layer composition root as complete without changing its runtime value. */
  static complete<L extends LayerInput>(layer: L & CompleteInput<L>): L {
    return layer
  }

  /** Replace providers in a base Layer, using tag identity and compatible contracts. */
  static override<Base extends LayerInput>(
    base: Base & ValidateLayerInput<Base>
  ): OverrideLayerResult<Base, readonly []>

  static override<
    Base extends LayerInput,
    const Overrides extends readonly [LayerInput, ...LayerInput[]]
  >(
    base: Base & ValidateLayerInput<Base>,
    ...overrides: Overrides & ValidateOverrides<Base, Overrides>
  ): OverrideLayerResult<Base, Overrides>

  static override<Base extends LayerInput, const Overrides extends readonly LayerInput[]>(
    base: Base & ValidateLayerInput<Base>,
    ...overrides: Overrides & ValidateOverrides<Base, Overrides>
  ): OverrideLayerResult<Base, Overrides>

  static override(base: LayerInput, ...overrides: readonly LayerInput[]): Layer<any, any> {
    const providers = new Map<string, LayerProvider>()

    for (const provider of base.providers) {
      providers.set(provider.service.serviceTag, provider)
    }

    for (const layer of overrides) {
      for (const provider of layer.providers) {
        providers.set(provider.service.serviceTag, provider)
      }
    }

    // SAFETY: Runtime provider replacement preserves the computed override metadata.
    return new Layer([...providers.values()]) as Layer<any, any>
  }
}

const normalizeAcquire =
  <S extends ServiceClass<any, any>>(
    acquire: () => MaybePromise<ServiceContract<InstanceType<S>>>
  ): (() => MaybePromise<InstanceType<S>>) =>
  () => {
    // SAFETY: ServiceContract removes only the declaration-only identity; runtime values are unchanged.
    return acquire() as MaybePromise<InstanceType<S>>
  }

/** Type-level aliases for inspecting Layer environments and completeness. */
export declare namespace Layer {
  /** The widened Layer shape accepted by generic Layer infrastructure. */
  export type Any = LayerInput

  /** Extract the branded Service instances provided by a Layer. */
  export type Provided<L extends LayerInput> = ProvidedEnvironment<L>

  /** Extract the external Service requirements of a Layer. */
  export type Required<L extends LayerInput> = RequiredEnvironment<L>

  /** Extract the Services still missing from a Layer composition. */
  export type Missing<L extends LayerInput> = RequiredEnvironment<L>

  /** Validate a Layer's requirements and input shape. */
  export type Complete<L extends LayerInput> = CompleteInput<L>
}
