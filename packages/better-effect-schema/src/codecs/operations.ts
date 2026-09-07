import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'

import {
  SchemaAsyncRequired,
  SchemaDefinitionFailure,
  SchemaEncodeFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../failure.js'
import type { SchemaEffect } from '../schema-effect.js'
import { invokeAsync, invokeSync } from '../internal/execution.js'
import {
  validateStandardAsync,
  validateStandardSync,
  type StandardValidation
} from '../internal/standard.js'
import { schemaFailure, schemaSuccess } from '../internal/result.js'
import type {
  AnySchemaCodec,
  CodecAsyncEncodeFailure,
  CodecEncoded,
  CodecEncodeFailure
} from './types.js'

type EncodeFailure<Codec> =
  | CodecEncodeFailure<Codec>
  | SchemaAsyncRequired
  | SchemaEncodeFailure
  | SchemaExecutionFailure

type AsyncEncodeFailure<Codec> =
  | CodecAsyncEncodeFailure<Codec>
  | SchemaEncodeFailure
  | SchemaExecutionFailure

export type CodecEncodeOperation<Codec extends AnySchemaCodec> = SchemaEffect<
  CodecEncoded<Codec>,
  EncodeFailure<Codec>
>

export type CodecEncodeAsyncOperation<Codec extends AnySchemaCodec> = Promise<
  SchemaEffect<CodecEncoded<Codec>, AsyncEncodeFailure<Codec>>
>

interface RuntimeCodec {
  readonly encodedSchema: StandardSchemaV1
  readonly encode: Function
  readonly encodeAsync: Function | undefined
}

type NormalizedEncoderResult =
  | { readonly _tag: 'value'; readonly value: unknown }
  | { readonly _tag: 'result'; readonly result: SchemaEffect<unknown, unknown> }

type Normalization = SchemaEffect<
  NormalizedEncoderResult,
  SchemaDefinitionFailure | SchemaExecutionFailure
>

const isObjectLike = (value: unknown): value is object | Function =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const identifierOf = (codec: unknown): string => {
  if (!isObjectLike(codec)) return 'SchemaCodec'

  try {
    const identifier = Reflect.get(codec, 'identifier')
    return typeof identifier === 'string' && identifier.trim().length > 0
      ? identifier
      : 'SchemaCodec'
  } catch {
    return 'SchemaCodec'
  }
}

const unsupported = (operation: string): SchemaEffect<never, SchemaUnsupportedOperation> =>
  schemaFailure(new SchemaUnsupportedOperation({ operation }))

const readCodec = (
  codec: unknown,
  operation: string,
  readAsyncEncoder: boolean
): SchemaEffect<RuntimeCodec, SchemaExecutionFailure | SchemaUnsupportedOperation> => {
  if (!isObjectLike(codec)) return unsupported(operation)

  try {
    // Reading the descriptor is intentional, but no decode-side validation is
    // performed here. Encoding must never manufacture an inverse transform.
    const schema = Reflect.get(codec, 'schema')
    const encodedSchema = Reflect.get(codec, 'encodedSchema')
    const encode = Reflect.get(codec, 'encode')
    const encodeAsync = readAsyncEncoder ? Reflect.get(codec, 'encodeAsync') : undefined

    if (schema === undefined || encodedSchema === undefined || typeof encode !== 'function') {
      return unsupported(operation)
    }

    if (readAsyncEncoder && encodeAsync !== undefined && typeof encodeAsync !== 'function') {
      return unsupported(operation)
    }

    return schemaSuccess<RuntimeCodec, SchemaUnsupportedOperation | SchemaExecutionFailure>({
      encodedSchema: encodedSchema as StandardSchemaV1,
      encode,
      encodeAsync: typeof encodeAsync === 'function' ? encodeAsync : undefined
    })
  } catch (cause) {
    return schemaFailure(
      new SchemaExecutionFailure({ identifier: identifierOf(codec), operation, cause })
    )
  }
}

const normalizeEncoderResult = (
  value: unknown,
  identifier: string,
  operation: string
): Normalization => {
  if (!isObjectLike(value)) {
    return schemaFailure<NormalizedEncoderResult, SchemaDefinitionFailure | SchemaExecutionFailure>(
      new SchemaDefinitionFailure({ identifier, operation, cause: 'invalid-result' })
    )
  }

  try {
    const status = Reflect.get(value, 'status')
    if (status === 'ok' && Reflect.has(value, 'value')) {
      return schemaSuccess<
        NormalizedEncoderResult,
        SchemaDefinitionFailure | SchemaExecutionFailure
      >({
        _tag: 'value',
        value: Reflect.get(value, 'value')
      })
    }

    if (status === 'error' && Reflect.has(value, 'error')) {
      return schemaSuccess<
        NormalizedEncoderResult,
        SchemaDefinitionFailure | SchemaExecutionFailure
      >({
        _tag: 'result',
        result: value as SchemaEffect<unknown, unknown>
      })
    }

    return schemaFailure<NormalizedEncoderResult, SchemaDefinitionFailure | SchemaExecutionFailure>(
      new SchemaDefinitionFailure({ identifier, operation, cause: 'invalid-result' })
    )
  } catch (cause) {
    return schemaFailure<NormalizedEncoderResult, SchemaDefinitionFailure | SchemaExecutionFailure>(
      new SchemaExecutionFailure({ identifier, operation, cause })
    )
  }
}

const encodeValidationSync = <Codec extends AnySchemaCodec>(
  codec: Codec,
  encodedSchema: StandardSchemaV1,
  value: unknown
): CodecEncodeOperation<Codec> => {
  const identifier = identifierOf(codec)
  const validated = validateStandardSync<CodecEncoded<Codec>>(
    encodedSchema,
    value,
    identifier,
    'encode',
    undefined
  )

  if (Result.isError(validated)) return validated as CodecEncodeOperation<Codec>

  const result: StandardValidation<CodecEncoded<Codec>> = validated.value
  switch (result._tag) {
    case 'success':
      return schemaSuccess<CodecEncoded<Codec>, EncodeFailure<Codec>>(result.value)
    case 'definition':
      return schemaFailure<CodecEncoded<Codec>, EncodeFailure<Codec>>(
        result.failure as unknown as EncodeFailure<Codec>
      )
    case 'failure':
      return schemaFailure<CodecEncoded<Codec>, EncodeFailure<Codec>>(
        new SchemaEncodeFailure({ identifier, operation: 'encode', issues: result.issues })
      )
  }
}

const encodeValidationAsync = async <Codec extends AnySchemaCodec>(
  codec: Codec,
  encodedSchema: StandardSchemaV1,
  value: unknown
): Promise<SchemaEffect<CodecEncoded<Codec>, AsyncEncodeFailure<Codec>>> => {
  const identifier = identifierOf(codec)
  const validated = await validateStandardAsync<CodecEncoded<Codec>>(
    encodedSchema,
    value,
    identifier,
    'encodeAsync',
    undefined
  )

  if (Result.isError(validated))
    return validated as SchemaEffect<CodecEncoded<Codec>, AsyncEncodeFailure<Codec>>

  const result: StandardValidation<CodecEncoded<Codec>> = validated.value
  switch (result._tag) {
    case 'success':
      return schemaSuccess<CodecEncoded<Codec>, AsyncEncodeFailure<Codec>>(result.value)
    case 'definition':
      return schemaFailure<CodecEncoded<Codec>, AsyncEncodeFailure<Codec>>(
        result.failure as unknown as AsyncEncodeFailure<Codec>
      )
    case 'failure':
      return schemaFailure<CodecEncoded<Codec>, AsyncEncodeFailure<Codec>>(
        new SchemaEncodeFailure({ identifier, operation: 'encodeAsync', issues: result.issues })
      )
  }
}

/** Execute one explicit codec encoder and validate its representation. */
export const encodeCodec = <Codec extends AnySchemaCodec>(
  codec: Codec,
  value: unknown
): CodecEncodeOperation<Codec> => {
  const descriptor = readCodec(codec, 'encode', false)
  if (Result.isError(descriptor)) return descriptor as CodecEncodeOperation<Codec>

  const invoked = invokeSync('encode', () => Reflect.apply(descriptor.value.encode, codec, [value]))
  if (Result.isError(invoked)) {
    return invoked as CodecEncodeOperation<Codec>
  }

  const normalized = normalizeEncoderResult(
    invoked.value,
    identifierOf(codec),
    'encode'
  )
  if (Result.isError(normalized)) return normalized as CodecEncodeOperation<Codec>
  if (normalized.value._tag === 'result') {
    return normalized.value.result as CodecEncodeOperation<Codec>
  }

  return encodeValidationSync(codec, descriptor.value.encodedSchema, normalized.value.value)
}

/** Execute one async-capable codec encoder and validate its representation. */
export const encodeCodecAsync = async <Codec extends AnySchemaCodec>(
  codec: Codec,
  value: unknown
): CodecEncodeAsyncOperation<Codec> => {
  const descriptor = readCodec(codec, 'encodeAsync', true)
  if (Result.isError(descriptor)) {
    return descriptor as unknown as Awaited<CodecEncodeAsyncOperation<Codec>>
  }

  const encoder = descriptor.value.encodeAsync ?? descriptor.value.encode
  const invoked = await invokeAsync('encodeAsync', () => Reflect.apply(encoder, codec, [value]))
  if (Result.isError(invoked)) {
    return invoked as unknown as Awaited<CodecEncodeAsyncOperation<Codec>>
  }

  const normalized = normalizeEncoderResult(
    invoked.value,
    identifierOf(codec),
    'encodeAsync'
  )
  if (Result.isError(normalized)) {
    return normalized as unknown as Awaited<CodecEncodeAsyncOperation<Codec>>
  }
  if (normalized.value._tag === 'result') {
    return normalized.value.result as unknown as Awaited<CodecEncodeAsyncOperation<Codec>>
  }

  return encodeValidationAsync(codec, descriptor.value.encodedSchema, normalized.value.value)
}
