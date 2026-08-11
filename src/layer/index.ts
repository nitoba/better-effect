export { Layer } from './layer'

export { buildLayer } from './runtime'

export {
  BuiltLayerDisposedError,
  DuplicateServiceError,
  LayerDisposeError,
  LayerGeneratorYieldError,
  LayerRegistrationError
} from './errors'

export type { BuiltLayer } from './runtime'

export type {
  CleanupFailureObserver,
  RuntimeOptions,
  RuntimeShutdownDiagnostic
} from '../runtime/outcome'

export type { LayerBackend } from './backend'

export type {
  AnyLayer,
  CompleteLayer,
  LayerMissing,
  LayerProvided,
  LayerRawRequired,
  LayerSpecs
} from './inference'

export type {
  AnyLayerSpec,
  LayerGenerator,
  LayerGeneratorRequirements,
  LayerRegistration,
  LayerSpec
} from './types'
