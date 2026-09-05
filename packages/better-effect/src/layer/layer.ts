import { Result } from 'better-result'

import type {
  EffectError,
  EffectRequirements,
  EffectSuccess,
  Program,
  ServiceRequirement
} from '../effect/types'
import { ServiceRuntime } from '../service'
import { captureServiceTag } from '../service/tag'
import type {
  AnyService,
  ServiceClass,
  ServiceContract,
  ServiceRequirements,
  ServiceToken
} from '../service'
import { ResourceNotDisposableError } from '../scope'
import { getDisposeFinalizer } from '../scope/disposable'

import type { DisposableResource, ScopeFinalizer, ScopeOutcome } from '../scope'
import type { Covariant, Invariant } from '../internal/variance'
import type { MaybePromise } from '../utils/types'

import { DuplicateServiceError, ServiceTagCollisionError } from './errors'
import {
  runLayerDiscardGenerator,
  runLayerDiscardIterator,
  runLayerGenerator,
  type LayerDiscardIterator
} from './internal'
import { captureLayerRegistrationTag } from './registration'

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
import type {
  LayerDiscardGenerator,
  LayerDiscardRequirements,
  LayerGenerator,
  LayerGeneratorRequirements,
  LayerRegistration
} from './types'

declare const LayerTypeId: unique symbol

interface LayerVariance<in out Provided, out Required> {
  readonly _Provided: Invariant<Provided>
  readonly _Required: Covariant<Required>
}

type CapturedLayerAcquisition = {
  readonly instance: unknown
  readonly release: ScopeFinalizer
}

interface LayerProvider extends LayerRegistration {
  /** The tag captured before this provider can cross an asynchronous boundary. */
  readonly serviceTag: string

  /** Provider storage deliberately erases the concrete instance type. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  readonly release?: (instance: unknown, outcome: ScopeOutcome) => MaybePromise<void>

  /** Capture acquisition-local cleanup without retaining the acquired instance. */
  readonly acquireWithRelease?: () => MaybePromise<CapturedLayerAcquisition>
}

/** Internal lifecycle entry that deliberately has no Service identity. */
export interface LayerLifecycleEntry {
  readonly kind: 'lifecycle'
  readonly id: symbol
  readonly acquire: () => MaybePromise<unknown>
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Lifecycle resources are intentionally opaque to the Layer runtime.
  readonly release: (instance: unknown, outcome: ScopeOutcome) => MaybePromise<void>
}

type LayerEntry = LayerProvider | LayerLifecycleEntry

const layerEntries = new WeakMap<object, readonly LayerEntry[]>()

const isLifecycleEntry = (entry: LayerEntry): entry is LayerLifecycleEntry =>
  'kind' in entry && entry.kind === 'lifecycle'

/** Read all entries while keeping lifecycle storage out of the public declaration. */
export const getLayerEntries = (layer: LayerInput): readonly LayerEntry[] =>
  layerEntries.get(layer) ?? layer.providers

type AnyProgram = Program<any, any, AnyService>

type EffectDiscardValidation<P extends AnyProgram> = [EffectSuccess<P>] extends [void]
  ? [EffectError<P>] extends [never]
    ? unknown
    : {
        readonly __betterEffectDiscardTypedFailure: unique symbol
      }
  : {
      readonly __betterEffectDiscardSuccessMustBeVoid: unique symbol
    }

/** A Service class whose constructor can be called without arguments. */
type DefaultConstructibleServiceClass<
  Tag extends string = string,
  Instance extends AnyService = AnyService
> = ServiceClass<Tag, Instance> & (new () => Instance)

type IsUnion<Type, Candidate = Type> = Type extends unknown
  ? [Candidate] extends [Type]
    ? false
    : true
  : never

type InvalidUnionAliasToken = {
  readonly __betterEffectUnionLayerAliasToken: unique symbol
}

type RejectUnionAliasToken<Token> = IsUnion<Token> extends true ? InvalidUnionAliasToken : unknown

type LayerAliasOptions<From extends ServiceToken<any, any>, To extends ServiceToken<any, any>> = {
  readonly from: From
  readonly to: To
} & RejectUnionAliasToken<From> &
  RejectUnionAliasToken<To> &
  ([ServiceContract<InstanceType<From>>] extends [ServiceContract<InstanceType<To>>]
    ? unknown
    : {
        readonly __betterEffectIncompatibleLayerAlias: unique symbol
      })

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

  /** The Service provider registrations retained by this Layer. */
  readonly providers: readonly LayerProvider[]

  private constructor(entries: readonly LayerEntry[]) {
    const frozenEntries = Object.freeze(
      entries.map((entry) => {
        if (isLifecycleEntry(entry)) {
          return Object.freeze({ ...entry })
        }

        return Object.freeze({
          ...entry,
          serviceTag: captureLayerRegistrationTag(entry)
        })
      })
    )

    layerEntries.set(this, frozenEntries)
    this.providers = Object.freeze(
      frozenEntries.filter((entry): entry is LayerProvider => !isLifecycleEntry(entry))
    )
  }

  private static makeLifecycleLayer<RawRequired extends AnyService>(
    acquire: () => MaybePromise<unknown>,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Lifecycle resources are intentionally opaque to the Layer runtime.
    release: (instance: unknown, outcome: ScopeOutcome) => MaybePromise<void>
  ): LayerResult<ProviderEntry<never, RawRequired>> {
    // SAFETY: Lifecycle entries have no public Service environment; the typed requirements are declaration-only provenance.
    return new Layer([
      {
        kind: 'lifecycle',
        id: Symbol('better-effect.lifecycle'),
        acquire,
        release
      }
    ]) as LayerResult<ProviderEntry<never, RawRequired>>
  }

  /** A stable provider-free Layer for composition roots with no Services. */
  static readonly empty: Layer<never, never> = Object.freeze(new Layer<never, never>([]))

  /** Create a Layer that lazily acquires a Service instance. */
  static make<S extends DefaultConstructibleServiceClass<any, any>>(
    service: S
  ): LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>>

  static make<S extends ServiceToken<any, any>>(
    service: S,
    acquire: () => MaybePromise<ServiceContract<InstanceType<S>>>
  ): LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>>

  static make<S extends ServiceToken<any, any>>(
    service: S,
    acquire?: () => MaybePromise<ServiceContract<InstanceType<S>>>
  ): LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>> {
    const serviceTag = captureServiceTag(service)
    const defaultAcquire = (): InstanceType<S> => {
      // SAFETY: The no-argument overload constrains `service` to a default constructible class.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the overload supplies the erased constructor guarantee.
      const Constructor = service as unknown as new () => InstanceType<S>

      return new Constructor()
    }

    const normalizedAcquire = normalizeAcquire<S>(acquire ?? defaultAcquire)

    // SAFETY: Runtime storage erases only the concrete provider metadata; the public constructor result restores its typed provenance.
    return new Layer([
      {
        service,
        serviceTag,
        acquire: normalizedAcquire
      }
    ]) as LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>>
  }

  /** Create a Layer from an already-constructed Service instance. */
  static succeed<S extends ServiceToken<any, any>>(
    service: S,
    instance: ServiceContract<InstanceType<S>>
  ): LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>> {
    const serviceTag = captureServiceTag(service)
    const normalizedAcquire = normalizeAcquire<S>(() => instance)

    // SAFETY: The structural instance has been checked against the requested Service contract.
    return new Layer([
      {
        service,
        serviceTag,
        acquire: normalizedAcquire
      }
    ]) as LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>>
  }

  /** Alias a source Service under a compatible target contract. */
  static alias<From extends ServiceToken<any, any>, To extends ServiceToken<any, any>>(
    options: LayerAliasOptions<From, To>
  ): LayerResult<
    ProviderEntry<InstanceType<To>, InstanceType<From> | ServiceRequirements<InstanceType<To>>>
  > {
    const { from, to } = options
    void captureServiceTag(from)

    // Keep alias acquisition in the normal Layer generator path so Runtime supplies the active resolver and resolution diagnostics.
    // oxlint-disable-next-line require-yield
    const alias = Layer.gen(to, async function* () {
      const source = await ServiceRuntime.resolve(from)

      // SAFETY: LayerAliasOptions checks that the source implementation satisfies the target contract.
      return source as ServiceContract<InstanceType<To>>
    })

    // SAFETY: The alias factory resolves the declared source token before returning the target contract.
    return alias as LayerResult<
      ProviderEntry<InstanceType<To>, InstanceType<From> | ServiceRequirements<InstanceType<To>>>
    >
  }

  /** Define a provider with Runtime-root cleanup. */
  static scoped<S extends ServiceToken<any, any>>(
    service: S,
    acquire: () => MaybePromise<ServiceContract<InstanceType<S>>>,
    release: (instance: InstanceType<S>, outcome: ScopeOutcome) => MaybePromise<void>
  ): LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>> {
    const serviceTag = captureServiceTag(service)

    // SAFETY: The public callbacks constrain acquisition and release to the requested Service.
    return new Layer([
      {
        service,
        serviceTag,
        acquire: normalizeAcquire<S>(acquire),
        release: (instance, outcome) => {
          // SAFETY: The backend invokes release with the instance acquired for this token.
          return release(instance as InstanceType<S>, outcome)
        }
      }
    ]) as LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>>
  }

  /** Define a provider with Runtime-root cleanup through its disposal protocol. */
  static scopedDisposable<S extends ServiceToken<any, any>>(
    service: S,
    acquire: () => MaybePromise<ServiceContract<InstanceType<S>> & DisposableResource>
  ): LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>> {
    const acquireWithRelease = async (): Promise<CapturedLayerAcquisition> => {
      const instance = await acquire()
      const finalizer = getDisposeFinalizer(instance)

      if (!finalizer) {
        throw new ResourceNotDisposableError()
      }

      return { instance, release: finalizer }
    }

    const serviceTag = captureServiceTag(service)

    // SAFETY: The public callback constrains the acquired value and this runtime-only carrier is erased at the Layer boundary.
    return new Layer([
      {
        service,
        serviceTag,
        acquire: async () => (await acquireWithRelease()).instance,
        acquireWithRelease
      }
    ]) as LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>>
  }

  /** Define a provider whose acquisition can yield contextual Services. */
  static scopedGen<S extends ServiceToken<any, any>, Yield extends ServiceRequirement<unknown>>(
    service: S,
    factory: LayerGenerator<S, Yield>,
    release: (instance: InstanceType<S>, outcome: ScopeOutcome) => MaybePromise<void>
  ): LayerResult<ProviderEntry<InstanceType<S>, LayerGeneratorRequirements<S, Yield>>> {
    const serviceTag = captureServiceTag(service)

    // SAFETY: The generator and release callback are checked against the requested Service.
    return new Layer([
      {
        service,
        serviceTag,
        acquire: () => runLayerGenerator(service, factory),
        release: (instance, outcome) => {
          // SAFETY: The backend invokes release with the instance acquired for this token.
          return release(instance as InstanceType<S>, outcome)
        }
      }
    ]) as LayerResult<ProviderEntry<InstanceType<S>, LayerGeneratorRequirements<S, Yield>>>
  }

  /** Define a provider whose acquisition can yield contextual Services. */
  static gen<S extends ServiceToken<any, any>, Yield extends ServiceRequirement<unknown>>(
    service: S,
    factory: LayerGenerator<S, Yield>
  ): LayerResult<ProviderEntry<InstanceType<S>, LayerGeneratorRequirements<S, Yield>>> {
    const serviceTag = captureServiceTag(service)

    // SAFETY: The generator result is normalized to the requested Service at the runtime boundary.
    return new Layer([
      {
        service,
        serviceTag,
        acquire: () => runLayerGenerator(service, factory)
      }
    ]) as LayerResult<ProviderEntry<InstanceType<S>, LayerGeneratorRequirements<S, Yield>>>
  }

  /** Define a lifecycle-only entry with direct acquisition and root cleanup. */
  static scopedDiscard<Yield extends ServiceRequirement<unknown>, Acquired>(
    acquire: LayerDiscardGenerator<Yield, Acquired>,
    release: (instance: Acquired, outcome: ScopeOutcome) => MaybePromise<void>
  ): LayerResult<ProviderEntry<never, LayerDiscardRequirements<Yield>>>

  static scopedDiscard<Acquired>(
    acquire: () => MaybePromise<Acquired>,
    release: (instance: Acquired, outcome: ScopeOutcome) => MaybePromise<void>
  ): LayerResult<ProviderEntry<never, never>>

  static scopedDiscard(
    acquire:
      | (() => MaybePromise<unknown>)
      | LayerDiscardGenerator<ServiceRequirement<unknown>, unknown>,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Lifecycle resources are intentionally opaque to the Layer runtime.
    release: (instance: unknown, outcome: ScopeOutcome) => MaybePromise<void>
  ): LayerResult<ProviderEntry<never, AnyService>> {
    return Layer.makeLifecycleLayer(() => {
      const acquired = acquire()

      if (isIteratorLike(acquired)) {
        return runLayerDiscardIterator(acquired)
      }

      return acquired
    }, release)
  }

  /** Define a lifecycle-only entry whose acquisition can yield contextual Services. */
  static scopedDiscardGen<Yield extends ServiceRequirement<unknown>, Acquired>(
    acquire: LayerDiscardGenerator<Yield, Acquired>,
    release: (instance: Acquired, outcome: ScopeOutcome) => MaybePromise<void>
  ): LayerResult<ProviderEntry<never, LayerDiscardRequirements<Yield>>> {
    // SAFETY: Lifecycle generator requirements are carried only in declaration metadata; runtime storage is intentionally erased.
    return Layer.makeLifecycleLayer(
      () => runLayerDiscardGenerator(acquire),
      (instance, outcome) => {
        // SAFETY: The overload constrains this resource to Acquired before the erased Layer boundary.
        return release(instance as Acquired, outcome)
      }
    ) as LayerResult<ProviderEntry<never, LayerDiscardRequirements<Yield>>>
  }

  /** Run a no-failure Effect Program as a lifecycle-only entry. */
  static effectDiscard<P extends AnyProgram>(
    program: P & EffectDiscardValidation<P>
  ): LayerResult<ProviderEntry<never, Extract<EffectRequirements<P>, AnyService>>> {
    // SAFETY: The public validation preserves the no-failure Program contract while the Layer entry erases its unit resource.
    return Layer.makeLifecycleLayer<Extract<EffectRequirements<P>, AnyService>>(
      async () => {
        const result = await program()

        if (Result.isError(result)) {
          throw result.error
        }
      },
      async () => {}
    ) as LayerResult<ProviderEntry<never, Extract<EffectRequirements<P>, AnyService>>>
  }

  /** Compose Layers without replacing providers. */
  static merge<const Layers extends readonly LayerInput[]>(
    ...layers: Layers & ValidateLayerTuple<Layers>
  ): MergeResult<Layers> {
    const entries = new Map<string | symbol, LayerEntry>()

    for (const layer of layers) {
      for (const entry of getLayerEntries(layer)) {
        if (isLifecycleEntry(entry)) {
          entries.set(entry.id, entry)
          continue
        }

        const service = entry.service
        const serviceTag = captureLayerRegistrationTag(entry)
        const existing = entries.get(serviceTag)

        if (existing) {
          if (isLifecycleEntry(existing)) {
            throw new Error('Layer lifecycle entry identity collided with a Service tag')
          }

          if (existing.service !== service) {
            throw new ServiceTagCollisionError(existing.service, service)
          }

          throw new DuplicateServiceError(service)
        }

        entries.set(serviceTag, entry)
      }
    }

    // SAFETY: The heterogeneous provider list is erased only at this internal storage boundary.
    return new Layer([...entries.values()]) as MergeResult<Layers>
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
    const entries = new Map<string | symbol, LayerEntry>()

    for (const entry of getLayerEntries(base)) {
      entries.set(isLifecycleEntry(entry) ? entry.id : captureLayerRegistrationTag(entry), entry)
    }

    for (const layer of overrides) {
      for (const entry of getLayerEntries(layer)) {
        entries.set(isLifecycleEntry(entry) ? entry.id : captureLayerRegistrationTag(entry), entry)
      }
    }

    // SAFETY: Runtime provider replacement preserves the computed override metadata.
    return new Layer([...entries.values()]) as Layer<any, any>
  }
}

// TypeScript's `readonly` does not affect the runtime property descriptor. Keep
// the class field's enumerable behavior while locking the singleton binding.
Object.defineProperty(Layer, 'empty', {
  value: Layer.empty,
  writable: false,
  enumerable: true,
  configurable: false
})

const normalizeAcquire =
  <S extends ServiceToken<any, any>>(
    acquire: () => MaybePromise<ServiceContract<InstanceType<S>>>
  ): (() => MaybePromise<InstanceType<S>>) =>
  () => {
    // SAFETY: ServiceContract removes only the declaration-only identity; runtime values are unchanged.
    return acquire() as MaybePromise<InstanceType<S>>
  }

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Lifecycle factories are runtime-erased at this boundary.
const isIteratorLike = (value: unknown): value is LayerDiscardIterator => {
  if (!(value instanceof Object) || !('next' in value)) {
    return false
  }

  return value.next instanceof Function
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
