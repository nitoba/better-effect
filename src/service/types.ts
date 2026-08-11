import type { EffectRequirements } from '../effect/types'

export type ServiceToken<A = unknown> = (abstract new (...args: any[]) => A) & {
  readonly name: string
}

export type AnyServiceToken = ServiceToken<any>

export type ServiceClass<A = unknown> = (new (...args: any[]) => A) & {
  readonly name: string
}

export type ServiceInstance<T extends AnyServiceToken> = InstanceType<T>

type MethodRequirements<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => infer Return ? EffectRequirements<Return> : never
}[keyof T]

/** Services required by the Effect-returning methods of a Service class. */
export type ServiceRequirements<T extends AnyServiceToken> = MethodRequirements<InstanceType<T>>
