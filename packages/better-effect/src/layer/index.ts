export { Layer } from './layer'

export { MapLayerBackend } from './map-layer-backend'

export {
  DuplicateServiceError,
  LayerDisposeError,
  LayerGeneratorYieldError,
  LayerRegistrationError,
  ServiceTagCollisionError
} from './errors'

export type {
  CleanupFailureObserver,
  RuntimeOptions,
  RuntimeShutdownDiagnostic
} from '../runtime/outcome'

export type { LayerBackend } from './backend'

export type { LayerGenerator, LayerGeneratorRequirements, LayerRegistration } from './types'
