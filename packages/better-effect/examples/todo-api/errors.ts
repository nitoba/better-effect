import { TaggedError } from 'better-result'

export class DatabaseFailure extends TaggedError('DatabaseFailure')<{
  readonly operation: string
  readonly cause: unknown
  readonly message: string
}> {}

export class PasswordFailure extends TaggedError('PasswordFailure')<{
  readonly cause: unknown
  readonly message: string
}> {}

export class InvalidCredentials extends TaggedError('InvalidCredentials')<{
  readonly message: string
}> {}

export class Unauthorized extends TaggedError('Unauthorized')<{
  readonly message: string
}> {}

export class TodoNotFound extends TaggedError('TodoNotFound')<{
  readonly id: string
  readonly message: string
}> {}

export class InvalidRequest extends TaggedError('InvalidRequest')<{
  readonly message: string
}> {}
