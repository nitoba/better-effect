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

export const redactedPostgresError = (operation: string, cause: unknown): PostgresAdapterError => {
  if (cause instanceof PostgresAdapterError) return cause
  return new PostgresAdapterError(`PostgreSQL ${operation} failed`, { cause })
}
