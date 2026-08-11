export class ScopeRuntimeNotConfiguredError extends Error {
  constructor() {
    super('No Scope is available in the current execution context')

    this.name = 'ScopeRuntimeNotConfiguredError'
  }
}

export class ScopeClosedError extends Error {
  constructor() {
    super('Cannot add resources or finalizers to a closed Scope')

    this.name = 'ScopeClosedError'
  }
}

export class ScopeCloseError extends Error {
  constructor(readonly causes: readonly unknown[]) {
    super(
      `Failed to close Scope (${causes.length} finalizer${causes.length === 1 ? '' : 's'} failed)`
    )

    this.name = 'ScopeCloseError'
  }
}

export class ResourceNotDisposableError extends Error {
  constructor() {
    super('Resource does not implement Symbol.dispose or Symbol.asyncDispose')

    this.name = 'ResourceNotDisposableError'
  }
}
