import { TaggedError } from 'better-result'

export type HttpNdjsonErrorKind = 'json' | 'truncated'

export class HttpNdjsonParseError extends TaggedError('HttpNdjsonParseError')<{
  readonly phase: 'ndjson'
  readonly kind: HttpNdjsonErrorKind
  readonly recordIndex: number
  readonly byteOffset: number
  readonly cause?: unknown
}> {}

export class HttpNdjsonUtf8Error extends TaggedError('HttpNdjsonUtf8Error')<{
  readonly phase: 'ndjson'
  readonly kind: 'utf8'
  readonly recordIndex: number
  readonly byteOffset: number
  readonly cause?: unknown
}> {}

export class HttpNdjsonLimitError extends TaggedError('HttpNdjsonLimitError')<{
  readonly phase: 'ndjson'
  readonly reason: 'record-too-large'
  readonly recordIndex: number
  readonly byteOffset: number
  readonly maxRecordBytes: number
}> {}

export type HttpNdjsonBoundaryError =
  | HttpNdjsonParseError
  | HttpNdjsonUtf8Error
  | HttpNdjsonLimitError
