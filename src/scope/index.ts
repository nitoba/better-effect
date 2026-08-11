export { Scope } from './scope'

export type { CloseableScope } from './scope'

export {
  ResourceNotDisposableError,
  ScopeClosedError,
  ScopeCloseError,
  ScopeRuntimeNotConfiguredError
} from './errors'

export type {
  CleanupFailureDiagnostic,
  DisposableResource,
  MaybePromise,
  ScopeFinalizer,
  ScopeOutcome
} from './types'
