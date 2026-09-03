export interface RedisErrorOptions {
  readonly cause?: unknown
}

export class RedisAdapterError extends Error {
  constructor(message: string, options: RedisErrorOptions = {}) {
    super(message)
    this.name = 'RedisAdapterError'
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

export class RedisConfigurationError extends RedisAdapterError {
  readonly field: string | undefined

  constructor(message: string, field?: string) {
    super(message)
    this.name = 'RedisConfigurationError'
    this.field = field
  }
}

export class RedisConnectionError extends RedisAdapterError {
  readonly operation: string

  constructor(operation: string, options: RedisErrorOptions = {}) {
    super(`Redis ${operation} failed`, options)
    this.name = 'RedisConnectionError'
    this.operation = operation
  }
}

export class RedisLayoutError extends RedisAdapterError {
  readonly field: string | undefined
  readonly code: string | undefined

  constructor(message: string, field?: string, code?: string, options: RedisErrorOptions = {}) {
    super(message, options)
    this.name = 'RedisLayoutError'
    this.field = field
    this.code = code
  }
}

export class RedisLayoutMismatchError extends RedisLayoutError {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(
      'Redis namespace layout is incompatible; run an explicit migration before retrying',
      undefined,
      'LAYOUT_MISMATCH'
    )
    this.name = 'RedisLayoutMismatchError'
    this.problems = Object.freeze([...problems])
  }
}

export class RedisScriptError extends RedisAdapterError {
  readonly script: string
  readonly operation: string
  readonly code: string | undefined

  constructor(script: string, operation: string, code?: string, options: RedisErrorOptions = {}) {
    super(`Redis script ${operation} failed`, options)
    this.name = 'RedisScriptError'
    this.script = script
    this.operation = operation
    this.code = code
  }
}

export const redactedRedisError = (operation: string, cause: unknown): RedisAdapterError => {
  if (cause instanceof RedisAdapterError) return cause
  return new RedisAdapterError(`Redis ${operation} failed`, { cause })
}
