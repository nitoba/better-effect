// oxlint-disable anti-slop/no-runtime-typeof -- driver errors have host-specific structural shapes.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- error-code extraction is localized at the host boundary.
export class SqliteAdapterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SqliteAdapterError'
  }
}

export class SqliteConfigurationError extends SqliteAdapterError {
  constructor(
    message: string,
    readonly field: string
  ) {
    super(`SQLite configuration ${field}: ${message}`)
    this.name = 'SqliteConfigurationError'
  }
}

export class SqliteMigrationError extends SqliteAdapterError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SqliteMigrationError'
  }
}

export class SqliteSchemaValidationError extends SqliteAdapterError {
  constructor(message: string) {
    super(message)
    this.name = 'SqliteSchemaValidationError'
  }
}

export const sqliteError = (operation: string, cause: unknown): SqliteAdapterError => {
  const code =
    cause !== null && typeof cause === 'object' && 'code' in cause
      ? String((cause as { readonly code: unknown }).code)
      : ''
  const retryable = /BUSY|LOCKED/u.test(code)
  return new SqliteAdapterError(
    `SQLite ${operation} failed${retryable ? ' (database busy)' : ''}`,
    {
      cause
    }
  )
}
