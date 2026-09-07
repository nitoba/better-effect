import { TaggedError } from 'better-result'

export class HttpStreamReadError extends TaggedError('HttpStreamReadError')<{
  readonly phase: 'read'
  readonly cause?: unknown
  readonly bytesRead: number
}> {
  override toJSON() {
    return { _tag: this._tag }
  }
}

export class HttpStreamConsumedError extends TaggedError('HttpStreamConsumedError')<{
  readonly phase: 'read'
}> {
  override toJSON() {
    return { _tag: this._tag }
  }
}

export class HttpStreamBodyError extends TaggedError('HttpStreamBodyError')<{
  readonly phase: 'body'
  readonly status: number
}> {
  override toJSON() {
    return { _tag: this._tag }
  }
}
export class HttpStreamUnexpectedEndError extends TaggedError('HttpStreamUnexpectedEndError')<{
  readonly phase: 'takeUntil'
}> {
  override toJSON() {
    return { _tag: this._tag }
  }
}
export class HttpSinkError extends TaggedError('HttpSinkError')<{
  readonly phase: 'sink'
  readonly cause?: unknown
}> {
  override toJSON() {
    return { _tag: this._tag }
  }
}

export type HttpStreamError =
  | HttpStreamReadError
  | HttpStreamConsumedError
  | HttpStreamBodyError
  | HttpStreamUnexpectedEndError
  | HttpSinkError
