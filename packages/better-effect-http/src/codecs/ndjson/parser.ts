/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- NDJSON is an intentionally untrusted wire boundary. */
import { decodeUnknownAsync, SchemaExecutionFailure } from 'better-effect-schema'
import { Result } from 'better-result'
import { HttpDecodeError } from '../../errors'
import type { HttpSchema, SchemaOutput } from '../../schema'
import type { StreamSession } from '../../stream/session'
import type { HttpStreamReadError } from '../../stream/errors'
import { HttpNdjsonLimitError, HttpNdjsonParseError, HttpNdjsonUtf8Error } from './errors'

export type NdjsonLimits = Readonly<{
  readonly maxRecordBytes?: number
}>

export type NdjsonOptions<S extends HttpSchema | undefined = HttpSchema | undefined> = Readonly<{
  readonly schema?: S
  readonly limits?: NdjsonLimits
  /** Accept a valid final JSON record when the transport ends without LF/CRLF. */
  readonly allowFinalRecordWithoutDelimiter?: boolean
}>

export type NdjsonOutput<S extends HttpSchema | undefined> = S extends HttpSchema
  ? SchemaOutput<S>
  : unknown

export type NdjsonError =
  | HttpNdjsonParseError
  | HttpNdjsonUtf8Error
  | HttpNdjsonLimitError
  | HttpDecodeError
  | HttpStreamReadError

const validateLimits = (limits: NdjsonLimits | undefined): void => {
  const maxRecordBytes = limits?.maxRecordBytes
  if (
    maxRecordBytes !== undefined &&
    (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0)
  )
    throw new RangeError('limits.maxRecordBytes must be a positive safe integer')
}

const concat = (chunks: readonly Uint8Array[], length: number): Uint8Array => {
  const value = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    value.set(chunk, offset)
    offset += chunk.byteLength
  }
  return value
}

const removeTrailingCarriageReturn = (value: Uint8Array): Uint8Array =>
  value.at(-1) === 0x0d ? value.subarray(0, value.byteLength - 1) : value

const schemaErrorKind = (cause: unknown): 'schema' | 'provider' =>
  cause instanceof SchemaExecutionFailure ? 'provider' : 'schema'

const readRecord = async function* <S extends HttpSchema | undefined>(
  source: StreamSession,
  options: NdjsonOptions<S>
): AsyncIterable<Result<NdjsonOutput<S>, NdjsonError>> {
  validateLimits(options.limits)
  const maxRecordBytes = options.limits?.maxRecordBytes
  const schema = options.schema
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: Uint8Array[] = []
  let recordBytes = 0
  let recordIndex = 0
  let byteOffset = 0
  let recordOffset = 0

  const decodeRecord = async (
    terminated: boolean
  ): Promise<Result<NdjsonOutput<S>, NdjsonError> | undefined> => {
    if (recordBytes === 0) return undefined
    const raw = removeTrailingCarriageReturn(concat(chunks, recordBytes))
    chunks.length = 0
    recordBytes = 0
    if (raw.byteLength === 0) return undefined
    const currentIndex = recordIndex++
    const currentOffset = recordOffset
    if (maxRecordBytes !== undefined && raw.byteLength > maxRecordBytes)
      return Result.err(
        new HttpNdjsonLimitError({
          phase: 'ndjson',
          reason: 'record-too-large',
          recordIndex: currentIndex,
          byteOffset: currentOffset,
          maxRecordBytes
        })
      )
    if (!terminated && !options.allowFinalRecordWithoutDelimiter)
      return Result.err(
        new HttpNdjsonParseError({
          phase: 'ndjson',
          kind: 'truncated',
          recordIndex: currentIndex,
          byteOffset: currentOffset
        })
      )

    let text: string
    try {
      text = decoder.decode(raw)
    } catch (cause) {
      return Result.err(
        new HttpNdjsonUtf8Error({
          phase: 'ndjson',
          kind: 'utf8',
          recordIndex: currentIndex,
          byteOffset: currentOffset,
          cause
        })
      )
    }

    let value: unknown
    try {
      value = JSON.parse(text) as unknown
    } catch (cause) {
      return Result.err(
        new HttpNdjsonParseError({
          phase: 'ndjson',
          kind: 'json',
          recordIndex: currentIndex,
          byteOffset: currentOffset,
          cause
        })
      )
    }

    if (schema === undefined) return Result.ok(value as NdjsonOutput<S>)
    try {
      const decoded = await decodeUnknownAsync(schema, value)
      if (Result.isError(decoded))
        return Result.err(
          new HttpDecodeError({
            phase: 'decode',
            kind: schemaErrorKind(decoded.error),
            cause: decoded.error,
            recordIndex: currentIndex,
            byteOffset: currentOffset
          })
        )
      return Result.ok(decoded.value as NdjsonOutput<S>)
    } catch (cause) {
      return Result.err(
        new HttpDecodeError({
          phase: 'decode',
          kind: schemaErrorKind(cause),
          cause,
          recordIndex: currentIndex,
          byteOffset: currentOffset
        })
      )
    }
  }

  try {
    for await (const item of source.results()) {
      if (Result.isError(item)) {
        yield Result.err(item.error)
        return
      }
      const bytes = item.value
      let segmentStart = 0
      for (let index = 0; index < bytes.byteLength; index++) {
        const byte = bytes[index]!
        if (byte !== 0x0a) continue
        if (index > segmentStart) {
          const segment = bytes.subarray(segmentStart, index)
          chunks.push(segment)
          recordBytes += segment.byteLength
        }
        const record = await decodeRecord(true)
        if (record !== undefined) {
          if (Result.isError(record)) {
            yield record
            return
          }
          yield record
        }
        byteOffset += index - segmentStart + 1
        recordOffset = byteOffset
        segmentStart = index + 1
      }
      if (segmentStart < bytes.byteLength) {
        const segment = bytes.subarray(segmentStart)
        chunks.push(segment)
        recordBytes += segment.byteLength
        if (maxRecordBytes !== undefined && recordBytes > maxRecordBytes + 1) {
          yield Result.err(
            new HttpNdjsonLimitError({
              phase: 'ndjson',
              reason: 'record-too-large',
              recordIndex,
              byteOffset: recordOffset,
              maxRecordBytes
            })
          )
          return
        }
      }
      byteOffset += bytes.byteLength - segmentStart
    }

    if (recordBytes > 0) {
      const record = await decodeRecord(false)
      if (record !== undefined) yield record
    }
  } catch (cause) {
    if (cause instanceof HttpNdjsonLimitError || cause instanceof HttpNdjsonParseError) {
      yield Result.err(cause)
      return
    }
    yield Result.err(
      new HttpNdjsonUtf8Error({
        phase: 'ndjson',
        kind: 'utf8',
        recordIndex,
        byteOffset: recordOffset,
        cause
      })
    )
  }
}

export const parseNdjson = <S extends HttpSchema | undefined>(
  source: StreamSession,
  options: NdjsonOptions<S>
): AsyncIterable<Result<NdjsonOutput<S>, NdjsonError>> => readRecord(source, options)
