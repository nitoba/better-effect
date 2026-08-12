import type { EffectRequirements } from '../effect/types'

type ServiceStatics<Tag extends string, Instance> = {
  readonly name: string
  readonly serviceTag: Tag

  /** Type-check a structural implementation and return it unchanged. */
  of(this: void, implementation: Instance): Instance
}

/** A class constructor carrying a Service tag and its instance contract. */
export type ServiceToken<Tag extends string = string, Instance = any> = (abstract new (
  ...args: any[]
) => Instance) &
  ServiceStatics<Tag, Instance>

/** The widened token constraint used by generic Service infrastructure. */
export type AnyServiceToken = ServiceToken<string, any>

/** A concrete, constructible Service class accepted by a Layer provider. */
export type ServiceClass<Tag extends string = string, Instance = any> = (new (
  ...args: any[]
) => Instance) &
  ServiceStatics<Tag, Instance>

/** Extract the instance type represented by a Service token. */
export type ServiceInstance<T extends AnyServiceToken> = InstanceType<T>

/** Extract the literal identity tag represented by a Service token. */
export type ServiceTag<T extends AnyServiceToken> = T['serviceTag']

type MethodRequirements<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => infer Return ? EffectRequirements<Return> : never
}[keyof T]

/**
 * Services required by the Effect-returning methods of a Service class.
 *
 * This type is used automatically by `Layer.make`, `Layer.gen`, and the other
 * provider constructors.
 */
export type ServiceRequirements<T extends AnyServiceToken> = MethodRequirements<InstanceType<T>>
