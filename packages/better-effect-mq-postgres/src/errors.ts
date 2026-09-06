export interface PostgresErrorOptions {
  readonly cause?: unknown
}

export class PostgresAdapterError extends Error {
  constructor(message: string, options: PostgresErrorOptions = {}) {
    super(message)
    this.name = 'PostgresAdapterError'
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: false
      })
    }
  }
}

export class PostgresConfigurationError extends PostgresAdapterError {
  readonly field: string | undefined

  constructor(message: string, field?: string) {
    super(message)
    this.name = 'PostgresConfigurationError'
    this.field = field
  }
}

export class PostgresMigrationError extends PostgresAdapterError {
  readonly migration: string | undefined

  constructor(message: string, migration?: string, options: PostgresErrorOptions = {}) {
    super(message, options)
    this.name = 'PostgresMigrationError'
    this.migration = migration
  }
}

export class PostgresSchemaValidationError extends PostgresAdapterError {
  readonly problems: readonly string[]

  constructor(message: string, problems: readonly string[] = []) {
    super(message)
    this.name = 'PostgresSchemaValidationError'
    this.problems = problems
  }
}

export class PostgresFlowProtocolMismatchError extends PostgresAdapterError {
  readonly expectedProtocolVersion: number
  readonly actualProtocolVersion: number | undefined
  readonly actualLayoutVersion: number | undefined

  constructor(args: {
    readonly expectedProtocolVersion: number
    readonly actualProtocolVersion?: number
    readonly actualLayoutVersion?: number
  }) {
    super(
      `PostgreSQL flow protocol mismatch: expected v${args.expectedProtocolVersion} with layout v1, found protocol v${args.actualProtocolVersion ?? 'unknown'} and migration layout ${args.actualLayoutVersion ?? 'unknown'}`
    )
    this.name = 'PostgresFlowProtocolMismatchError'
    this.expectedProtocolVersion = args.expectedProtocolVersion
    this.actualProtocolVersion = args.actualProtocolVersion
    this.actualLayoutVersion = args.actualLayoutVersion
  }
}

export const redactedPostgresError = (operation: string, cause: unknown): PostgresAdapterError => {
  if (cause instanceof PostgresAdapterError) return cause
  return new PostgresAdapterError(`PostgreSQL ${operation} failed`, { cause })
}
