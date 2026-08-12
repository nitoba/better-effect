import type { EffectRequirements } from '../effect/types'

export type ServiceToken<Tag extends string = string, Instance = any> = (abstract new (
  ...args: any[]
) => Instance) & {
  readonly name: string
  readonly serviceTag: Tag
}

export type AnyServiceToken = ServiceToken<string, any>

export type ServiceClass<Tag extends string = string, Instance = any> = (new (
  ...args: any[]
) => Instance) & {
  readonly name: string
  readonly serviceTag: Tag
}

export type ServiceInstance<T extends AnyServiceToken> = InstanceType<T>

export type ServiceTag<T extends AnyServiceToken> = T['serviceTag']

type MethodRequirements<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => infer Return ? EffectRequirements<Return> : never
}[keyof T]

/** Services required by the Effect-returning methods of a Service class. */
export type ServiceRequirements<T extends AnyServiceToken> = MethodRequirements<InstanceType<T>>
