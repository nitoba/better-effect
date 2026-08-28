/** Thrown when no RuntimeContext is active in the selected storage. */
export class RuntimeContextNotConfiguredError extends Error {
  constructor() {
    super('No RuntimeContext is available in the current execution context')

    this.name = 'RuntimeContextNotConfiguredError'
  }
}

/** Thrown when ExplicitRuntimeContextStorage cannot safely overlap lineages. */
export class RuntimeContextOverlapError extends Error {
  constructor() {
    super(
      'ExplicitRuntimeContextStorage does not support overlapping root or derived context runs; use NodeRuntimeContextStorage for concurrent async branches'
    )

    this.name = 'RuntimeContextOverlapError'
  }
}
