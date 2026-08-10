import type { ServiceClass } from '../service/types'

export type MaybePromise<T> = T | PromiseLike<T>

export interface LayerProvider {
  readonly service: ServiceClass<any>

  readonly acquire: () => MaybePromise<unknown>

  readonly release?: (instance: unknown) => MaybePromise<void>
}
