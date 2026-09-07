import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'

import {
  SchemaAsyncRequired,
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaEncodeFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from './failure.js'
import { isGenericSchemaClass, type AnyGenericSchemaClass } from './is-schema-class.js'
import { encodeCodec, encodeCodecAsync } from './codecs/operations.js'
import type { AnySchemaCodec, CodecEncoded, CodecOutput } from './codecs/index.js'
import { findGenericDescriptor } from './internal/generic-descriptor.js'
import { invokeAsync, invokeSync } from './internal/execution.js'
import { schemaFailure, schemaSuccess } from './internal/result.js'
import {
  validateStandardAsync,
  validateStandardSync,
  type StandardValidation
} from './internal/standard.js'
import type {
  GenericClassDefinition,
  GenericClassFailure,
  GenericSchemaClass
} from './types/generic-class.js'
import type { Encoded as EncodedType, Instance } from './types/extractors.js'
import type { SchemaEffect } from './schema-effect.js'

export type { SchemaEffect } from './schema-effect.js'

type AnyStandardSchema = StandardSchemaV1
type GenericClassDecodeInput<Class> = Class extends {
  readonly schema: infer Schema extends AnyStandardSchema
}
  ? StandardSchemaV1.InferInput<Schema>
  : never
type GenericClassConstructionInput<Class> = Class extends {
  readonly propsSchema: infer Schema extends AnyStandardSchema
}
  ? StandardSchemaV1.InferInput<Schema>
  : never
type DecodeFailure =
  | SchemaDecodeFailure
  | SchemaDefinitionFailure
  | SchemaExecutionFailure
  | SchemaAsyncRequired
type ConstructionFailure = SchemaConstructionFailure | SchemaExecutionFailure | SchemaAsyncRequired
type GenericDecodeFailure = DecodeFailure | SchemaConstructionFailure
type GenericConstructionOperation<Class extends AnyGenericSchemaClass> = SchemaEffect<
  Instance<Class>,
  GenericClassFailure
>
type GenericDecodeOperation<Class extends AnyGenericSchemaClass> = SchemaEffect<
  Instance<Class>,
  GenericDecodeFailure
>
type GenericEncodeFailure =
  | SchemaEncodeFailure
  | SchemaDefinitionFailure
  | SchemaExecutionFailure
  | SchemaAsyncRequired
  | SchemaUnsupportedOperation
type GenericEncodeOperation<Class extends AnyGenericSchemaClass> = SchemaEffect<
  EncodedType<Class>,
  GenericEncodeFailure
>
type DecodeOperation<Schema extends AnyStandardSchema> = SchemaEffect<
  StandardSchemaV1.InferOutput<Schema>,
  DecodeFailure
>
type CodecEncodeOperation<Codec extends AnySchemaCodec> = ReturnType<typeof encodeCodec<Codec>>
type CodecEncodeAsyncOperation<Codec extends AnySchemaCodec> = ReturnType<
  typeof encodeCodecAsync<Codec>
>

const genericDecodeFailure = (
  error: GenericDecodeFailure
): GenericDecodeOperation<AnyGenericSchemaClass> =>
  schemaFailure<unknown, GenericDecodeFailure>(error) as GenericDecodeOperation<AnyGenericSchemaClass>

const genericDecodeSuccess = (value: unknown): GenericDecodeOperation<AnyGenericSchemaClass> =>
  schemaSuccess<unknown, GenericDecodeFailure>(value) as GenericDecodeOperation<AnyGenericSchemaClass>

const genericEncodeFailure = (
  error: GenericEncodeFailure
): GenericEncodeOperation<AnyGenericSchemaClass> =>
  schemaFailure<unknown, GenericEncodeFailure>(error) as GenericEncodeOperation<AnyGenericSchemaClass>

const genericEncodeSuccess = (value: unknown): GenericEncodeOperation<AnyGenericSchemaClass> =>
  schemaSuccess<unknown, GenericEncodeFailure>(value) as GenericEncodeOperation<AnyGenericSchemaClass>

const identifierOf = (schema: unknown): string => {
  if ((typeof schema !== 'object' || schema === null) && typeof schema !== 'function') {
    return 'Schema'
  }
  try {
    const identifier = Reflect.get(schema, 'identifier')
    return typeof identifier === 'string' && identifier.trim().length > 0 ? identifier : 'Schema'
  } catch {
    return 'Schema'
  }
}

const decodeResult = <Schema extends AnyStandardSchema>(
  identifier: string,
  result: StandardValidation<StandardSchemaV1.InferOutput<Schema>>
): DecodeOperation<Schema> => {
  switch (result._tag) {
    case 'success':
      return schemaSuccess<StandardSchemaV1.InferOutput<Schema>, DecodeFailure>(result.value)
    case 'definition':
      return schemaFailure<StandardSchemaV1.InferOutput<Schema>, DecodeFailure>(result.failure)
    case 'failure':
      return schemaFailure<StandardSchemaV1.InferOutput<Schema>, DecodeFailure>(
        new SchemaDecodeFailure({ identifier, issues: result.issues, cause: result.issues })
      )
  }
}

const decodeGenericSync = (
  schemaClass: AnyGenericSchemaClass,
  input: unknown,
  options: StandardSchemaV1.Options | undefined
): GenericDecodeOperation<AnyGenericSchemaClass> => {
  const descriptor = findGenericDescriptor(schemaClass)
  if (descriptor === undefined) {
    return schemaFailure(
      new SchemaDefinitionFailure({ operation: 'decode', cause: 'missing-descriptor' })
    ) as GenericDecodeOperation<AnyGenericSchemaClass>
  }

  const decoded = validateStandardSync(
    descriptor.schema,
    input,
    descriptor.identifier,
    'decode',
    options
  )
  if (Result.isError(decoded)) return decoded as unknown as GenericDecodeOperation<AnyGenericSchemaClass>
  if (decoded.value._tag === 'definition') return genericDecodeFailure(decoded.value.failure)
  if (decoded.value._tag === 'failure') {
    return genericDecodeFailure(
      new SchemaDecodeFailure({
        identifier: descriptor.identifier,
        operation: 'decode',
        issues: decoded.value.issues,
        cause: decoded.value.issues
      })
    )
  }

  const constructed = Reflect.apply(schemaClass.make, schemaClass, [decoded.value.value]) as Result<
    unknown,
    GenericClassFailure
  >
  return Result.isError(constructed)
    ? (constructed as unknown as GenericDecodeOperation<AnyGenericSchemaClass>)
    : genericDecodeSuccess(constructed.value)
}

const decodeGenericAsync = async (
  schemaClass: AnyGenericSchemaClass,
  input: unknown,
  options: StandardSchemaV1.Options | undefined
): Promise<GenericDecodeOperation<AnyGenericSchemaClass>> => {
  const descriptor = findGenericDescriptor(schemaClass)
  if (descriptor === undefined) {
    return schemaFailure(
      new SchemaDefinitionFailure({ operation: 'decodeAsync', cause: 'missing-descriptor' })
    ) as GenericDecodeOperation<AnyGenericSchemaClass>
  }

  const decoded = await validateStandardAsync(
    descriptor.schema,
    input,
    descriptor.identifier,
    'decodeAsync',
    options
  )
  if (Result.isError(decoded)) return decoded as unknown as GenericDecodeOperation<AnyGenericSchemaClass>
  if (decoded.value._tag === 'definition') return genericDecodeFailure(decoded.value.failure)
  if (decoded.value._tag === 'failure') {
    return genericDecodeFailure(
      new SchemaDecodeFailure({
        identifier: descriptor.identifier,
        operation: 'decodeAsync',
        issues: decoded.value.issues,
        cause: decoded.value.issues
      })
    )
  }

  const constructed = (await Reflect.apply(schemaClass.makeAsync, schemaClass, [decoded.value.value])) as Result<
    unknown,
    GenericClassFailure
  >
  return Result.isError(constructed)
    ? (constructed as unknown as GenericDecodeOperation<AnyGenericSchemaClass>)
    : genericDecodeSuccess(constructed.value)
}

const encodeGenericSync = (
  schemaClass: AnyGenericSchemaClass,
  value: unknown
): GenericEncodeOperation<AnyGenericSchemaClass> => {
  const descriptor = findGenericDescriptor(schemaClass)
  if (descriptor === undefined) return genericEncodeFailure(new SchemaDefinitionFailure({ operation: 'encode', cause: 'missing-descriptor' }))
  if (descriptor.preparationFailure !== undefined) return genericEncodeFailure(descriptor.preparationFailure)

  let encoder: unknown
  try {
    encoder = Reflect.get(descriptor.definition, 'encode')
  } catch (cause) {
    return genericEncodeFailure(new SchemaExecutionFailure({ identifier: descriptor.identifier, operation: 'encode', cause }))
  }
  if (typeof encoder !== 'function') {
    return genericEncodeFailure(new SchemaUnsupportedOperation({
      identifier: descriptor.identifier,
      operation: 'encode',
      cause: 'missing-encoding-capability'
    }))
  }

  const encoded = invokeSync('encode', () => Reflect.apply(encoder, descriptor.definition, [value]))
  if (Result.isError(encoded)) return encoded as unknown as GenericEncodeOperation<AnyGenericSchemaClass>
  if (descriptor.encodedSchema === undefined) return genericEncodeSuccess(encoded.value)

  const validated = validateStandardSync(
    descriptor.encodedSchema,
    encoded.value,
    descriptor.identifier,
    'encode',
    undefined
  )
  if (Result.isError(validated)) return validated as unknown as GenericEncodeOperation<AnyGenericSchemaClass>
  if (validated.value._tag === 'success') return genericEncodeSuccess(validated.value.value)
  if (validated.value._tag === 'definition') return genericEncodeFailure(validated.value.failure)
  return genericEncodeFailure(new SchemaEncodeFailure({
    identifier: descriptor.identifier,
    operation: 'encode',
    issues: validated.value.issues,
    cause: validated.value.issues
  }))
}

const encodeGenericAsync = async (
  schemaClass: AnyGenericSchemaClass,
  value: unknown
): Promise<GenericEncodeOperation<AnyGenericSchemaClass>> => {
  const descriptor = findGenericDescriptor(schemaClass)
  if (descriptor === undefined) return genericEncodeFailure(new SchemaDefinitionFailure({ operation: 'encodeAsync', cause: 'missing-descriptor' }))
  if (descriptor.preparationFailure !== undefined) return genericEncodeFailure(descriptor.preparationFailure)

  let encoder: unknown
  try {
    encoder = Reflect.get(descriptor.definition, 'encode')
  } catch (cause) {
    return genericEncodeFailure(new SchemaExecutionFailure({ identifier: descriptor.identifier, operation: 'encodeAsync', cause }))
  }
  if (typeof encoder !== 'function') {
    return genericEncodeFailure(new SchemaUnsupportedOperation({
      identifier: descriptor.identifier,
      operation: 'encodeAsync',
      cause: 'missing-encoding-capability'
    }))
  }

  const encoded = await invokeAsync('encodeAsync', () => Reflect.apply(encoder, descriptor.definition, [value]))
  if (Result.isError(encoded)) return encoded as unknown as GenericEncodeOperation<AnyGenericSchemaClass>
  if (descriptor.encodedSchema === undefined) return genericEncodeSuccess(encoded.value)

  const validated = await validateStandardAsync(
    descriptor.encodedSchema,
    encoded.value,
    descriptor.identifier,
    'encodeAsync',
    undefined
  )
  if (Result.isError(validated)) return validated as unknown as GenericEncodeOperation<AnyGenericSchemaClass>
  if (validated.value._tag === 'success') return genericEncodeSuccess(validated.value.value)
  if (validated.value._tag === 'definition') return genericEncodeFailure(validated.value.failure)
  return genericEncodeFailure(new SchemaEncodeFailure({
    identifier: descriptor.identifier,
    operation: 'encodeAsync',
    issues: validated.value.issues,
    cause: validated.value.issues
  }))
}

export function decodeUnknown<Class extends AnyGenericSchemaClass>(
  schema: Class
): (input: unknown) => GenericDecodeOperation<Class>
export function decodeUnknown<Class extends AnyGenericSchemaClass>(
  schema: Class,
  input: unknown
): GenericDecodeOperation<Class>
export function decodeUnknown<Schema extends AnyStandardSchema>(
  schema: Schema
): (input: unknown) => DecodeOperation<Schema>
export function decodeUnknown<Schema extends AnyStandardSchema>(
  schema: Schema,
  input: unknown,
  options?: StandardSchemaV1.Options
): DecodeOperation<Schema>
export function decodeUnknown<Schema extends AnyStandardSchema>(
  schema: Schema,
  input?: unknown,
  options?: StandardSchemaV1.Options
): unknown {
  if (isGenericSchemaClass(schema)) {
    const run = (value: unknown): GenericDecodeOperation<typeof schema> =>
      decodeGenericSync(schema, value, options) as unknown as GenericDecodeOperation<typeof schema>
    return arguments.length === 1 ? run : run(input)
  }
  const run = (value: unknown): DecodeOperation<Schema> => {
    const result = validateStandardSync(schema, value, identifierOf(schema), 'decodeUnknown', options)
    return Result.isError(result)
      ? (result as DecodeOperation<Schema>)
      : decodeResult(identifierOf(schema), result.value)
  }
  return arguments.length === 1 ? run : run(input)
}

export function decode<Class extends AnyGenericSchemaClass>(
  schema: Class
): (input: GenericClassDecodeInput<Class>) => GenericDecodeOperation<Class>
export function decode<Class extends AnyGenericSchemaClass>(
  schema: Class,
  input: GenericClassDecodeInput<Class>
): GenericDecodeOperation<Class>
export function decode<Schema extends AnyStandardSchema>(
  schema: Schema
): (input: StandardSchemaV1.InferInput<Schema>) => DecodeOperation<Schema>
export function decode<Schema extends AnyStandardSchema>(
  schema: Schema,
  input: StandardSchemaV1.InferInput<Schema>,
  options?: StandardSchemaV1.Options
): DecodeOperation<Schema>
export function decode<Schema extends AnyStandardSchema>(
  schema: Schema,
  input?: StandardSchemaV1.InferInput<Schema>,
  options?: StandardSchemaV1.Options
): unknown {
  if (isGenericSchemaClass(schema)) {
    const run = (value: unknown): GenericDecodeOperation<typeof schema> =>
      decodeGenericSync(schema, value, options) as unknown as GenericDecodeOperation<typeof schema>
    return arguments.length === 1 ? run : run(input)
  }
  const run = (value: StandardSchemaV1.InferInput<Schema>): DecodeOperation<Schema> => {
    const result = validateStandardSync(schema, value, identifierOf(schema), 'decode', options)
    return Result.isError(result)
      ? (result as DecodeOperation<Schema>)
      : decodeResult(identifierOf(schema), result.value)
  }
  return arguments.length === 1 ? run : run(input as StandardSchemaV1.InferInput<Schema>)
}

export function decodeUnknownAsync<Class extends AnyGenericSchemaClass>(
  schema: Class
): (input: unknown) => Promise<GenericDecodeOperation<Class>>
export function decodeUnknownAsync<Class extends AnyGenericSchemaClass>(
  schema: Class,
  input: unknown
): Promise<GenericDecodeOperation<Class>>
export function decodeUnknownAsync<Schema extends AnyStandardSchema>(
  schema: Schema
): (input: unknown) => Promise<DecodeOperation<Schema>>
export function decodeUnknownAsync<Schema extends AnyStandardSchema>(
  schema: Schema,
  input: unknown,
  options?: StandardSchemaV1.Options
): Promise<DecodeOperation<Schema>>
export function decodeUnknownAsync<Schema extends AnyStandardSchema>(
  schema: Schema,
  input?: unknown,
  options?: StandardSchemaV1.Options
): unknown {
  if (isGenericSchemaClass(schema)) {
    const run = async (value: unknown): Promise<GenericDecodeOperation<typeof schema>> =>
      decodeGenericAsync(schema, value, options) as Promise<GenericDecodeOperation<typeof schema>>
    return arguments.length === 1 ? run : run(input)
  }
  const run = async (value: unknown): Promise<DecodeOperation<Schema>> => {
    const result = await validateStandardAsync(schema, value, identifierOf(schema), 'decodeUnknownAsync', options)
    return Result.isError(result)
      ? (result as DecodeOperation<Schema>)
      : decodeResult(identifierOf(schema), result.value)
  }
  return arguments.length === 1 ? run : run(input)
}

export function decodeAsync<Class extends AnyGenericSchemaClass>(
  schema: Class
): (input: GenericClassDecodeInput<Class>) => Promise<GenericDecodeOperation<Class>>
export function decodeAsync<Class extends AnyGenericSchemaClass>(
  schema: Class,
  input: GenericClassDecodeInput<Class>
): Promise<GenericDecodeOperation<Class>>
export function decodeAsync<Schema extends AnyStandardSchema>(
  schema: Schema
): (input: StandardSchemaV1.InferInput<Schema>) => Promise<DecodeOperation<Schema>>
export function decodeAsync<Schema extends AnyStandardSchema>(
  schema: Schema,
  input: StandardSchemaV1.InferInput<Schema>,
  options?: StandardSchemaV1.Options
): Promise<DecodeOperation<Schema>>
export function decodeAsync<Schema extends AnyStandardSchema>(
  schema: Schema,
  input?: StandardSchemaV1.InferInput<Schema>,
  options?: StandardSchemaV1.Options
): unknown {
  if (isGenericSchemaClass(schema)) {
    const run = async (value: unknown): Promise<GenericDecodeOperation<typeof schema>> =>
      decodeGenericAsync(schema, value, options) as Promise<GenericDecodeOperation<typeof schema>>
    return arguments.length === 1 ? run : run(input)
  }
  const run = async (value: StandardSchemaV1.InferInput<Schema>): Promise<DecodeOperation<Schema>> => {
    const result = await validateStandardAsync(schema, value, identifierOf(schema), 'decodeAsync', options)
    return Result.isError(result)
      ? (result as DecodeOperation<Schema>)
      : decodeResult(identifierOf(schema), result.value)
  }
  return arguments.length === 1 ? run : run(input as StandardSchemaV1.InferInput<Schema>)
}

export function encode<Class extends AnyGenericSchemaClass>(
  schema: Class
): (value: Instance<Class>) => GenericEncodeOperation<Class>
export function encode<Class extends AnyGenericSchemaClass>(
  schema: Class,
  value: Instance<Class>
): GenericEncodeOperation<Class>
export function encode<Codec extends AnySchemaCodec>(
  codec: Codec
): (value: CodecOutput<Codec>) => CodecEncodeOperation<Codec>
export function encode<Codec extends AnySchemaCodec>(
  codec: Codec,
  value: CodecOutput<Codec>
): CodecEncodeOperation<Codec>
export function encode(codec: AnySchemaCodec | AnyGenericSchemaClass, value?: unknown): unknown {
  const run = (input: unknown): unknown =>
    isGenericSchemaClass(codec)
      ? encodeGenericSync(codec, input)
      : encodeCodec(codec as AnySchemaCodec, input)
  return arguments.length === 1 ? run : run(value)
}

export function encodeAsync<Class extends AnyGenericSchemaClass>(
  schema: Class
): (value: Instance<Class>) => Promise<GenericEncodeOperation<Class>>
export function encodeAsync<Class extends AnyGenericSchemaClass>(
  schema: Class,
  value: Instance<Class>
): Promise<GenericEncodeOperation<Class>>
export function encodeAsync<Codec extends AnySchemaCodec>(
  codec: Codec
): (value: CodecOutput<Codec>) => CodecEncodeAsyncOperation<Codec>
export function encodeAsync<Codec extends AnySchemaCodec>(
  codec: Codec,
  value: CodecOutput<Codec>
): CodecEncodeAsyncOperation<Codec>
export function encodeAsync(codec: AnySchemaCodec | AnyGenericSchemaClass, value?: unknown): unknown {
  const run = (input: unknown): Promise<unknown> =>
    isGenericSchemaClass(codec)
      ? encodeGenericAsync(codec, input)
      : encodeCodecAsync(codec as AnySchemaCodec, input)
  return arguments.length === 1 ? run : run(value)
}

export function make<Class extends AnyGenericSchemaClass>(
  schemaClass: Class
): (props: GenericClassConstructionInput<Class>) => GenericConstructionOperation<Class>
export function make<Class extends AnyGenericSchemaClass>(
  schemaClass: Class,
  props: GenericClassConstructionInput<Class>
): GenericConstructionOperation<Class>
export function make<Class extends AnyGenericSchemaClass>(schemaClass: Class, props?: unknown): unknown {
  const run = (input: unknown): GenericConstructionOperation<AnyGenericSchemaClass> =>
    Reflect.apply(schemaClass.make, schemaClass, [input]) as unknown as GenericConstructionOperation<AnyGenericSchemaClass>
  return arguments.length === 1 ? run : run(props)
}

export function makeAsync<Class extends AnyGenericSchemaClass>(
  schemaClass: Class
): (props: GenericClassConstructionInput<Class>) => Promise<GenericConstructionOperation<Class>>
export function makeAsync<Class extends AnyGenericSchemaClass>(
  schemaClass: Class,
  props: GenericClassConstructionInput<Class>
): Promise<GenericConstructionOperation<Class>>
export function makeAsync<Class extends AnyGenericSchemaClass>(schemaClass: Class, props?: unknown): unknown {
  const run = async (input: unknown): Promise<GenericConstructionOperation<AnyGenericSchemaClass>> =>
    Reflect.apply(schemaClass.makeAsync, schemaClass, [input]) as unknown as Promise<GenericConstructionOperation<AnyGenericSchemaClass>>
  return arguments.length === 1 ? run : run(props)
}
