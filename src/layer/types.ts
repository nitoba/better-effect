import type { ServiceClass } from '../service'
import type { MaybePromise } from '../utils/types'

export interface LayerProvider {
  readonly service: ServiceClass<any>

  readonly acquire: () => MaybePromise<unknown>

  readonly release?: (instance: unknown) => MaybePromise<void>
}

export type LayerGenerator<S extends ServiceClass<any>> = () => AsyncGenerator<
  never,
  InstanceType<S>,
  unknown
>
