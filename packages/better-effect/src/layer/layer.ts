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

import type {
  AnyLayer,
  CompleteLayer,
  LayerMissing,
  LayerProvided,
  LayerRawRequired,
  LayerSpecs,
  OverrideLayerCollisions,
  OverrideLayerSpecs
} from './inference'

declare const LayerTypeId: unique symbol
declare const LayerCollisionTypeId: unique symbol

interface LayerProvider extends LayerRegistration {
  readonly release?: (instance: unknown, outcome: ScopeOutcome) => MaybePromise<void>
}

/** A Service class whose constructor can be called without arguments. */
type DefaultConstructibleServiceClass<Tag extends string = string, Instance = any> = ServiceClass<
  Tag,
  Instance
> &
  (new () => Instance)

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
  Specs extends AnyLayerSpec = AnyLayerSpec,
  Collisions extends AnyServiceToken = never
> {
  declare readonly [LayerTypeId]: Specs
  declare readonly [LayerCollisionTypeId]: Collisions

  /** The provider registrations retained by this Layer. */
  readonly providers: readonly LayerProvider[]

  private constructor(providers: readonly LayerProvider[]) {
    this.providers = Object.freeze([...providers])
  }

  /**
   * Create a Layer that lazily acquires a Service instance.
   *
   * When the acquire callback is omitted, the Service must be constructible
   * without required constructor arguments and is instantiated with `new`.
   * Supplying an acquire callback remains available for custom construction.
   *
   * The acquire callback runs when the provider is first resolved by a
   * Runtime. Dependencies declared by Effect-returning Service methods are
   * tracked in the Layer's type.
   *
   * @example
   * ```ts
   * const DatabaseLive = Layer.make(Database)
   * ```
   *
   * @example
   * ```ts
   * const DatabaseLive = Layer.make(Database, () => new Database(config))
   * ```
   */
  static make<S extends DefaultConstructibleServiceClass<any, any>>(
    service: S
  ): Layer<LayerSpec<S, ServiceRequirements<S>>>

  static make<S extends ServiceClass<any, any>>(
    service: S,
    acquire: () => MaybePromise<InstanceType<S>>
  ): Layer<LayerSpec<S, ServiceRequirements<S>>>

  static make<S extends ServiceClass<any, any>>(
    service: S,
    acquire?: () => MaybePromise<InstanceType<S>>
  ): Layer<LayerSpec<S, ServiceRequirements<S>>> {
    const defaultAcquire = (): InstanceType<S> => {
      const Constructor = service as new () => InstanceType<S>

      return new Constructor()
    }

    return new Layer([
      {
        service,
        acquire: acquire ?? defaultAcquire
      }
    ])
  }

  /**
   * Create a Layer from an already-constructed Service instance.
   *
   * The instance is returned as-is whenever the Service is resolved.
   *
   * @example
   * ```ts
   * const DatabaseLive = Layer.succeed(Database, database)
   * ```
   */
  static succeed<S extends ServiceClass<any, any>>(
    service: S,
    instance: InstanceType<S>
  ): Layer<LayerSpec<S, ServiceRequirements<S>>> {
    return Layer.make(service, () => instance)
  }

  /**
   * Define a provider with Runtime-root cleanup.
   *
   * The release callback intentionally keeps its compatibility-friendly
   * one-argument shape and runs when the owning Runtime is disposed. Use
   * `scopedGen` when acquisition needs contextual Services or cleanup needs
   * `ScopeOutcome`.
   *
   * @example
   * ```ts
   * const DatabaseLive = Layer.scoped(
   *   Database,
   *   () => openDatabase(),
   *   (database) => database.close()
   * )
   * ```
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

  /**
   * Define a provider whose acquisition can yield contextual Services.
   *
   * The release callback receives the acquired instance and the final
   * `ScopeOutcome` selected by the owning Runtime.
   *
   * @example
   * ```ts
   * const RepositoryLive = Layer.scopedGen(
   *   UserRepository,
   *   async function* () {
   *     const database = yield* Database
   *     return new UserRepository(database)
   *   },
   *   (repository, outcome) => repository.close(outcome)
   * )
   * ```
   */
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

  /**
   * Define a provider whose acquisition can yield contextual Services.
   *
   * Unlike `scopedGen`, this variant has no release callback. Use it for
   * providers whose lifetime is managed elsewhere or that need no cleanup.
   *
   * @example
   * ```ts
   * const RepositoryLive = Layer.gen(UserRepository, async function* () {
   *   const database = yield* Database
   *   return new UserRepository(database)
   * })
   * ```
   */
  static gen<S extends ServiceClass<any, any>, Yield extends ServiceRequirement<AnyServiceToken>>(
    service: S,
    factory: LayerGenerator<S, Yield>
  ): Layer<LayerSpec<S, LayerGeneratorRequirements<S, Yield>>> {
    return Layer.make(service, () => runLayerGenerator(service, factory))
  }

  /**
   * Compose Layers without replacing providers.
   *
   * Each Service tag may appear only once. Duplicate tags are rejected at
   * runtime; use `override` when replacement is intentional.
   *
   * @example
   * ```ts
   * const AppLive = Layer.merge(DatabaseLive, RepositoryLive)
   * ```
   */
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

  /**
   * Replace providers in a base Layer, using tag identity and compatible
   * instance contracts.
   *
   * Overrides are applied from left to right; the last compatible provider for
   * a tag wins. Incompatible same-tag replacements remain visible as a type
   * diagnostic and cannot be passed as a complete Layer.
   *
   * @example
   * ```ts
   * const TestLive = Layer.override(AppLive, Layer.succeed(Database, fakeDb))
   * ```
   */
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

/** Type-level aliases for inspecting Layer providers and completeness. */
export declare namespace Layer {
  /** The widened Layer shape accepted by inference helpers. */
  export type Any = AnyLayer

  /** Extract the provider specification union from a Layer. */
  export type Specs<L extends AnyLayer> = LayerSpecs<L>

  /** Extract the Service constructors provided by a Layer. */
  export type Provided<L extends AnyLayer> = LayerProvided<L>

  /** Extract the raw Service requirements declared by a Layer. */
  export type Required<L extends AnyLayer> = LayerRawRequired<L>

  /** Extract the Service requirements missing from a Layer. */
  export type Missing<L extends AnyLayer> = LayerMissing<L>

  /** Validate a Layer's requirements and override contracts. */
  export type Complete<L extends AnyLayer> = CompleteLayer<L>
}
