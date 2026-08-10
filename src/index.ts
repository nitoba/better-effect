export { Service } from './service/service'

export { ServiceRuntime } from './service/runtime'

export type { ServiceResolver } from './service/runtime'

export type { AnyServiceToken, ServiceInstance } from './service/types'

export { Layer } from './layer/layer'
export { buildLayer, RuntimeLayer } from './layer/runtime'

export type { LayerBackend, BuiltLayer } from './layer'

export { Resource, ResourceReleaseFailure } from './resource'

export type {
  AcquireUseReleaseOptions,
  AsyncResult,
  DisposableResource,
  MaybePromise,
  ReleaseOutcome
} from './resource'

export { ItiLayerBackend } from './adapters/iti'
