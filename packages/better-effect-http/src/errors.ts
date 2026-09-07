// oxlint-disable anti-slop/no-unknown-parameters -- safeErrorJSON is the deliberate untrusted-failure boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- SafeErrorJSON is an allowlisted diagnostic envelope.
// oxlint-disable anti-slop/no-known-value-widening -- the JSON helper intentionally erases unsafe failure details.
// oxlint-disable anti-slop/no-runtime-typeof -- hostile failure values are narrowed at this serialization boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the assertion follows the _tag property check.
import { TaggedError } from 'better-result'

export type SafeErrorJSON = Readonly<{
  readonly _tag: string
  readonly status?: number
  readonly statusText?: string
}>

export type HttpErrorPhase =
  | 'request'
  | 'transport'
  | 'status'
  | 'timeout'
  | 'abort'
  | 'decode'
  | 'hook'
  | 'auth'

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
  override toJSON(): SafeErrorJSON {
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
  readonly recordIndex?: number
  readonly byteOffset?: number
}> {}
export class HttpHookError extends TaggedError('HttpHookError')<{
  readonly phase: 'hook'
  readonly cause: unknown
}> {}
export class HttpLimitError extends TaggedError('HttpLimitError')<{
  readonly phase: 'admission'
  readonly reason: 'queue-full'
}> {}
export class HttpAuthRefreshError extends TaggedError('HttpAuthRefreshError')<{
  readonly phase: 'auth'
  readonly reason: 'not-replayable' | 'refresh-failed'
  readonly cause?: unknown
}> {}

export type HttpError =
  | HttpRequestError
  | HttpTransportError
  | HttpStatusError
  | HttpTimeoutError
  | HttpAbortError
  | HttpDecodeError
  | HttpHookError
  | HttpLimitError
  | HttpAuthRefreshError

export const safeErrorJSON = (error: unknown): SafeErrorJSON => {
  if (error instanceof HttpStatusError) return error.toJSON()
  if (error !== null && typeof error === 'object' && '_tag' in error) {
    const tag = (error as { readonly _tag?: unknown })._tag
    return typeof tag === 'string' ? { _tag: tag } : { _tag: 'UnknownHttpError' }
  }
  return { _tag: 'UnknownHttpError' }
}
