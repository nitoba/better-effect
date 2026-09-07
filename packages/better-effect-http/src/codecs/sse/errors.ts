import { TaggedError } from 'better-result'

export type SseLimitName = 'maxLineBytes' | 'maxEventBytes' | 'maxBufferedEvents' | 'maxBufferBytes'

export class SseParseError extends TaggedError('SseParseError')<{
  readonly phase: 'parse'
  readonly cause?: unknown
}> {}

export class SseUnexpectedEventError extends TaggedError('SseUnexpectedEventError')<{
  readonly phase: 'event'
  readonly event: string
}> {}

export class SseLimitError extends TaggedError('SseLimitError')<{
  readonly phase: 'limit'
  readonly limit: SseLimitName
  readonly actual: number
  readonly maximum: number
}> {}

export class SseResponseError extends TaggedError('SseResponseError')<{
  readonly phase: 'response'
  readonly reason: 'mime' | 'body'
  readonly status: number
  readonly contentType?: string
}> {}

export type SseError = SseParseError | SseUnexpectedEventError | SseLimitError | SseResponseError
