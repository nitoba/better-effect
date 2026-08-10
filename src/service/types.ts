export type ServiceToken<A = unknown> = (abstract new (...args: any[]) => A) & {
  readonly name: string
}

export type AnyServiceToken = ServiceToken<any>

export type ServiceClass<A = unknown> = (new (...args: any[]) => A) & {
  readonly name: string
}

export type ServiceInstance<T extends AnyServiceToken> = InstanceType<T>
