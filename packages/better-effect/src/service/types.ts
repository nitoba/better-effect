import type { EffectRequirements, ServiceRequirement } from '../effect/types'

/** Internal type-only identity for the branded Service instance. */
export declare const ServiceIdentityTypeId: unique symbol

/** A branded Service instance identity carried by the literal Service tag. */
export interface ServiceIdentity<out Tag extends string = string> {
  readonly [ServiceIdentityTypeId]: Tag
}

/** The widened Service instance constraint used by contextual APIs. */
export type AnyService = ServiceIdentity<string>

/** Remove the internal Service identity marker from an implementation contract. */
export type ServiceContract<S> = S extends unknown ? Omit<S, typeof ServiceIdentityTypeId> : never

export type ServiceStatics<out Tag extends string, in out Instance extends AnyService> = {
  readonly name: string
  readonly serviceTag: Tag

  readonly [Symbol.iterator]: () => Generator<ServiceRequirement<Instance>, Instance, unknown>
  readonly [Symbol.asyncIterator]: () => AsyncGenerator<
    ServiceRequirement<Instance>,
    Instance,
    unknown
  >

  /** Type-check a structural implementation and return it unchanged. */
  readonly of: (this: void, implementation: ServiceContract<Instance>) => Instance
}

type AbstractServiceConstructor<out Instance> = abstract new (...args: any[]) => Instance

/** A class constructor carrying a Service tag and its instance contract. */
export interface ServiceToken<
  out Tag extends string = string,
  in out Instance extends AnyService = any
>
  extends AbstractServiceConstructor<Instance>, ServiceStatics<Tag, Instance> {}

/** The widened token constraint used by generic Service infrastructure. */
export type AnyServiceToken = ServiceToken<string, any>

/** A concrete, constructible Service class accepted by a Layer provider. */
export type ServiceClass<
  Tag extends string = string,
  Instance extends AnyService = AnyService
> = (new (...args: any[]) => Instance) & ServiceStatics<Tag, Instance>

/** Extract the instance type represented by a Service token. */
export type ServiceInstance<T extends AnyServiceToken> = InstanceType<T>

/** Extract the literal identity tag represented by a branded Service instance. */
export type ServiceTagOf<S extends AnyService> = S[typeof ServiceIdentityTypeId]

/** Extract the Service token represented by a branded Service instance. */
export type ServiceTokenOf<S extends AnyService> = S extends AnyService
  ? ServiceToken<ServiceTagOf<S>, S>
  : never

/** Extract the literal identity tag represented by a Service instance or token. */
export type ServiceTag<T extends AnyService | AnyServiceToken> = T extends AnyService
  ? ServiceTagOf<T>
  : T extends AnyServiceToken
    ? T['serviceTag']
    : never

type MethodRequirements<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => infer Return ? EffectRequirements<Return> : never
}[keyof T]

/**
 * Services required by the Effect-returning methods of a Service class.
 *
 * This type is used automatically by `Layer.make`, `Layer.gen`, and the other
 * provider constructors.
 */
export type ServiceRequirements<S extends AnyService> = MethodRequirements<S>
