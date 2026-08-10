export type ServiceToken<A = unknown> = (abstract new (...args: any[]) => A) & {
  readonly name: string
}

export type ServiceClass<A = unknown> = ServiceToken<A>

export type AnyServiceToken = ServiceToken<any>

export type ServiceInstance<T extends AnyServiceToken> = InstanceType<T>
