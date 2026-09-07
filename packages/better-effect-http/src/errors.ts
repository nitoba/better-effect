import { TaggedError } from 'better-result'

export type HttpErrorPhase =
  | 'request'
  | 'transport'
  | 'status'
  | 'timeout'
  | 'abort'
  | 'decode'
  | 'hook'

export class HttpRequestError extends TaggedError('HttpRequestError')<{
  readonly phase: 'request'
  readonly cause?: unknown
  readonly details?: string
}> {}
export class HttpTransportError extends TaggedError('HttpTransportError')<{
  readonly phase: 'transport'
  readonly cause?: unknown
}> {}
export class HttpStatusError extends TaggedError('HttpStatusError')<{
  readonly phase: 'status'
  readonly status: number
  readonly statusText: string
  readonly headers: Headers
  readonly url: string
  readonly body?: unknown
}> {
  override toJSON(): Record<string, unknown> {
    return { _tag: this._tag, status: this.status, statusText: this.statusText }
  }
}
export class HttpTimeoutError extends TaggedError('HttpTimeoutError')<{
  readonly phase: 'timeout'
  readonly timeout: number
  readonly cause?: unknown
}> {}
export class HttpAbortError extends TaggedError('HttpAbortError')<{
  readonly phase: 'abort'
  readonly cause?: unknown
}> {}
export class HttpDecodeError extends TaggedError('HttpDecodeError')<{
  readonly phase: 'decode'
  readonly kind: 'schema' | 'provider'
  readonly cause?: unknown
}> {}
export class HttpHookError extends TaggedError('HttpHookError')<{
  readonly phase: 'hook'
  readonly cause: unknown
}> {}

export type HttpError =
  | HttpRequestError
  | HttpTransportError
  | HttpStatusError
  | HttpTimeoutError
  | HttpAbortError
  | HttpDecodeError
  | HttpHookError

export const safeErrorJSON = (error: unknown): Record<string, unknown> => {
  if (error instanceof HttpStatusError) return error.toJSON()
  if (error !== null && typeof error === 'object' && '_tag' in error) {
    const tag = (error as { readonly _tag?: unknown })._tag
    return typeof tag === 'string' ? { _tag: tag } : { _tag: 'UnknownHttpError' }
  }
  return { _tag: 'UnknownHttpError' }
}
