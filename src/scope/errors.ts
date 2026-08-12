/** Thrown when Scope context is accessed outside an active Scope execution. */
export class ScopeRuntimeNotConfiguredError extends Error {
  constructor() {
    super('No Scope is available in the current execution context')

    this.name = 'ScopeRuntimeNotConfiguredError'
  }
}

/** Thrown when a resource or finalizer is added after Scope closure begins. */
export class ScopeClosedError extends Error {
  constructor() {
    super('Cannot add resources or finalizers to a closed Scope')

    this.name = 'ScopeClosedError'
  }
}

/** Aggregates finalizer failures encountered while closing a Scope. */
export class ScopeCloseError extends Error {
  constructor(readonly causes: readonly unknown[]) {
    super(
      `Failed to close Scope (${causes.length} finalizer${causes.length === 1 ? '' : 's'} failed)`
    )

    this.name = 'ScopeCloseError'
  }
}

/** Thrown when a value has neither Symbol.dispose nor Symbol.asyncDispose. */
export class ResourceNotDisposableError extends Error {
  constructor() {
    super('Resource does not implement Symbol.dispose or Symbol.asyncDispose')

    this.name = 'ResourceNotDisposableError'
  }
}
