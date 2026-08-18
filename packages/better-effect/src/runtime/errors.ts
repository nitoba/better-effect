/** Thrown when no RuntimeContext is active in the selected storage. */
export class RuntimeContextNotConfiguredError extends Error {
  constructor() {
    super('No RuntimeContext is available in the current execution context')

    this.name = 'RuntimeContextNotConfiguredError'
  }
}
