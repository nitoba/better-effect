import { TaggedError } from 'better-result'

export class HttpStreamReadError extends TaggedError('HttpStreamReadError')<{
  readonly phase: 'read'
  readonly cause?: unknown
  readonly bytesRead: number
}> {}

export class HttpStreamConsumedError extends TaggedError('HttpStreamConsumedError')<{
  readonly phase: 'read'
}> {}

export class HttpStreamBodyError extends TaggedError('HttpStreamBodyError')<{
  readonly phase: 'body'
  readonly status: number
}> {}

export type HttpStreamError = HttpStreamReadError | HttpStreamConsumedError | HttpStreamBodyError
