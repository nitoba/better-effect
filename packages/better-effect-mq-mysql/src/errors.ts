export interface MySqlErrorOptions {
  readonly cause?: unknown
}

export class MySqlAdapterError extends Error {
  constructor(message: string, options: MySqlErrorOptions = {}) {
    super(message)
    this.name = 'MySqlAdapterError'
    if (options.cause !== undefined)
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: options.cause
      })
  }
}
export class MySqlConfigurationError extends MySqlAdapterError {
  constructor(
    message: string,
    readonly field?: string
  ) {
    super(message)
    this.name = 'MySqlConfigurationError'
  }
}
export class MySqlMigrationError extends MySqlAdapterError {
  constructor(
    message: string,
    readonly migration?: string,
    options: MySqlErrorOptions = {}
  ) {
    super(message, options)
    this.name = 'MySqlMigrationError'
  }
}
export class MySqlSchemaValidationError extends MySqlAdapterError {
  constructor(
    message: string,
    readonly problems: readonly string[] = []
  ) {
    super(message)
    this.name = 'MySqlSchemaValidationError'
  }
}

/** Deliberately excludes driver SQL, parameters, and connection strings from the public message. */
export const redactedMySqlError = (operation: string, cause: unknown): MySqlAdapterError =>
  cause instanceof MySqlAdapterError
    ? cause
    : new MySqlAdapterError(`MySQL ${operation} failed`, { cause })
