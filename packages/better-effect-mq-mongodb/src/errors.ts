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

export class MongoFlowProtocolMismatchError extends MongoJobStoreError {
  readonly expectedProtocolVersion: number
  readonly actualProtocolVersion: number | undefined
  readonly actualLayoutVersion: number | undefined

  constructor(args: {
    readonly expectedProtocolVersion: number
    readonly actualProtocolVersion?: number | undefined
    readonly actualLayoutVersion?: number | undefined
  }) {
    super(
      `MongoDB flow protocol mismatch: expected v${args.expectedProtocolVersion} with layout v1, found protocol v${args.actualProtocolVersion ?? 'unknown'} and flow layout ${args.actualLayoutVersion ?? 'unknown'}`
    )
    this.name = 'MongoFlowProtocolMismatchError'
    this.expectedProtocolVersion = args.expectedProtocolVersion
    this.actualProtocolVersion = args.actualProtocolVersion
    this.actualLayoutVersion = args.actualLayoutVersion
  }
}

/** Never copy a command, URI, payload, or driver message into public diagnostics. */
export const redactedMongoError = (operation: string, cause: unknown): MongoJobStoreError =>
  cause instanceof MongoJobStoreError
    ? cause
    : new MongoJobStoreError(`MongoDB ${operation} failed`, { cause })
