export class MongoJobStoreError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message)
    this.name = 'MongoJobStoreError'
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false })
    }
  }
}

export class MongoJobStoreConfigurationError extends MongoJobStoreError {
  constructor(
    message: string,
    readonly field?: string
  ) {
    super(message)
    this.name = 'MongoJobStoreConfigurationError'
  }
}

export class MongoJobStoreTopologyError extends MongoJobStoreError {
  constructor(
    readonly topology: 'standalone' | 'unknown',
    message: string
  ) {
    super(message)
    this.name = 'MongoJobStoreTopologyError'
  }
}

export class MongoJobStoreLayoutError extends MongoJobStoreError {
  constructor(
    message: string,
    readonly problems: readonly string[] = []
  ) {
    super(message)
    this.name = 'MongoJobStoreLayoutError'
  }
}

export class MongoJobStoreMigrationError extends MongoJobStoreError {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options)
    this.name = 'MongoJobStoreMigrationError'
  }
}

/** Never copy a command, URI, payload, or driver message into public diagnostics. */
export const redactedMongoError = (operation: string, cause: unknown): MongoJobStoreError =>
  cause instanceof MongoJobStoreError
    ? cause
    : new MongoJobStoreError(`MongoDB ${operation} failed`, { cause })
